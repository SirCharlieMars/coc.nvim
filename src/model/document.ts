import { Buffer, Neovim } from '@chemzqm/neovim'
import debounce from 'debounce'
import { DidChangeTextDocumentParams, Disposable, Emitter, Event, Position, Range, TextDocument, TextEdit } from 'vscode-languageserver-protocol'
import Uri from 'vscode-uri'
import { BufferOption, ChangeInfo } from '../types'
import { diffLines, getChange } from '../util/diff'
import { isGitIgnored } from '../util/fs'
import { disposeAll, getUri } from '../util/index'
import { byteLength } from '../util/string'
import { Chars } from './chars'
const logger = require('../util/logger')('model-document')

// wrapper class of TextDocument
export default class Document {
  public tabstop: number
  public expandtab: boolean
  public paused: boolean
  public buftype: string
  public isIgnored = false
  public chars: Chars
  public textDocument: TextDocument
  public fetchContent: Function & { clear(): void; }
  private nvim: Neovim
  private _fireContentChanges: Function & { clear(): void; }
  private _onDocumentChange = new Emitter<DidChangeTextDocumentParams>()
  private attached = false
  private disposables: Disposable[] = []
  // real current lines
  private lines: string[] = []
  private _changedtick: number
  private _words: string[] = []
  public readonly onDocumentChange: Event<DidChangeTextDocumentParams> = this._onDocumentChange.event
  constructor(public buffer: Buffer) {
    this._fireContentChanges = debounce(() => {
      this.fireContentChanges()
    }, 20)
    this.fetchContent = debounce(() => {
      this._fetchContent().catch(_e => {
        // noop
      })
    }, 50)
    let paused = false
    Object.defineProperty(this, 'paused', {
      get: () => {
        return paused
      },
      set: (val: boolean) => {
        if (val == paused) return
        if (val) {
          // fire immediatelly
          this._fireContentChanges.clear()
          this.fireContentChanges()
          paused = true
        } else {
          paused = false
          // fire immediatelly
          this._fireContentChanges.clear()
          this.fireContentChanges()
        }
      }
    })
  }

  public get words(): string[] {
    return this._words
  }

  private generateWords(): void {
    if (this.isIgnored) return
    let { content } = this
    this._words = this.chars.matchKeywords(content)
  }

  public setFiletype(filetype: string): void {
    let { uri, version } = this
    version = version ? version + 1 : 1
    let textDocument = TextDocument.create(uri, filetype, version, this.content)
    this.textDocument = textDocument
  }

  /**
   * Current changedtick of buffer
   *
   * @public
   * @returns {number}
   */
  public get changedtick(): number {
    return this._changedtick
  }

  public get schema(): string {
    return Uri.parse(this.uri).scheme
  }

  public async init(nvim: Neovim, buftype: string): Promise<void> {
    this.nvim = nvim
    let { buffer } = this
    this.buftype = buftype
    let opts = await nvim.call('coc#util#get_bufoptions', [buffer.id]) as BufferOption
    this.expandtab = opts.expandtab
    this.tabstop = opts.tabstop
    this.lines = await buffer.lines as string[]
    this._changedtick = opts.changedtick
    let { fullpath, filetype, iskeyword } = opts
    let uri = getUri(fullpath, buffer.id)
    let chars = this.chars = new Chars(iskeyword)
    if (this.includeDash(filetype)) chars.addKeyword('-')
    this.textDocument = TextDocument.create(uri, filetype, 0, this.lines.join('\n'))
    this.attach()
    this.attached = true
    this.gitCheck().then(() => {
      this.generateWords()
    }, e => {
      logger.error('git error', e.stack)
    })
  }

  public get lineCount(): number {
    return this.lines.length
  }

  /**
   * Real current line
   *
   * @public
   * @param {number} line - zero based line number
   * @returns {string}
   */
  public getline(line: number): string {
    return this.lines[line] || ''
  }

  public attach(): void {
    let unbindLines = this.buffer.listen('lines', (...args) => {
      try {
        this.onChange.apply(this, args)
      } catch (e) {
        logger.error(e.stack)
      }
    })
    let unbindDetach = this.buffer.listen('detach', () => {
      logger.debug('buffer detach')
    })
    let unbindChange = this.buffer.listen('changedtick', (_buf: Buffer, tick: number) => {
      this._changedtick = tick
    })
    this.disposables.push(
      Disposable.create(() => {
        unbindDetach()
        unbindLines()
        unbindChange()
      })
    )
  }

  private onChange(
    buf: Buffer,
    tick: number,
    firstline: number,
    lastline: number,
    linedata: string[],
    // more:boolean
  ): void {
    if (tick == null) return
    if (buf.id !== this.buffer.id) return
    this._changedtick = tick
    this.lines.splice(firstline, lastline - firstline, ...linedata)
    this._fireContentChanges()
  }

  /**
   * Make sure current document synced correctly
   *
   * @public
   * @returns {Promise<void>}
   */
  public async checkDocument(): Promise<void> {
    this.paused = false
    let { buffer } = this
    this._fireContentChanges.clear()
    this._changedtick = await buffer.changedtick
    this.lines = await buffer.lines
    this.fireContentChanges()
  }

  private fireContentChanges(): void {
    let { paused, textDocument } = this
    if (paused) return
    try {
      let content = this.lines.join('\n')
      if (content == this.content) return
      let change = getChange(this.content, content)
      this.createDocument()
      let { version, uri } = this
      let changes = [{
        range: {
          start: textDocument.positionAt(change.start),
          end: textDocument.positionAt(change.end)
        },
        rangeLength: change.end - change.start,
        text: change.newText
      }]
      this._onDocumentChange.fire({
        textDocument: { version, uri },
        contentChanges: changes
      })
      this.generateWords()
    } catch (e) {
      logger.error(e.message)
    }
  }

  public detach(): void {
    if (!this.attached) return
    this.attached = false
    disposeAll(this.disposables)
    this.fetchContent.clear()
    this._fireContentChanges.clear()
    this._onDocumentChange.dispose()
  }

  public get bufnr(): number {
    return this.buffer.id
  }

  public get content(): string {
    return this.textDocument.getText()
  }

  public get filetype(): string {
    return this.textDocument.languageId
  }

  public get uri(): string {
    return this.textDocument ? this.textDocument.uri : null
  }

  public get version(): number {
    return this.textDocument ? this.textDocument.version : null
  }

  public equalTo(doc: TextDocument): boolean {
    return doc.uri == this.uri
  }

  public setKeywordOption(option: string): void {
    this.chars = new Chars(option)
  }

  public async applyEdits(nvim: Neovim, edits: TextEdit[]): Promise<void> {
    if (edits.length == 0) return
    let orig = this.content
    let content = TextDocument.applyEdits(this.textDocument, edits)
    // could be equal
    if (orig === content) return
    let cur = await nvim.buffer
    let buf = this.buffer
    if (cur.id == buf.id) {
      let d = diffLines(orig, content)
      if (d.end - d.start == 1 && d.replacement.length == 1) {
        await nvim.call('coc#util#setline', [d.start + 1, d.replacement[0]])
      } else {
        await buf.setLines(d.replacement, {
          start: d.start,
          end: d.end,
          strictIndexing: false
        })
      }
    } else {
      await buf.setLines(content.split(/\r?\n/), {
        start: 0,
        end: -1,
        strictIndexing: false
      })
    }
    this._fireContentChanges.clear()
    this.fireContentChanges()
  }

  public getOffset(lnum: number, col: number): number {
    return this.textDocument.offsetAt({
      line: lnum - 1,
      character: col
    })
  }

  public isWord(word: string): boolean {
    return this.chars.isKeyword(word)
  }

  public getMoreWords(): string[] {
    let res = []
    let { words, chars } = this
    if (!chars.isKeywordChar('-')) return res
    for (let word of words) {
      word = word.replace(/^-+/, '')
      if (word.indexOf('-') !== -1) {
        let parts = word.split('-')
        for (let part of parts) {
          if (part.length > 2
            && res.indexOf(part) === -1
            && words.indexOf(part) === -1) {
            res.push(part)
          }
        }
      }
    }
    return res
  }

  /**
   * Current word for replacement, used by completion
   * For increment completion, the document is initialized document
   *
   * @public
   * @param {Position} position
   * @param {string} extraChars?
   * @returns {Range}
   */
  public getWordRangeAtPosition(position: Position, extraChars?: string): Range {
    let { chars, textDocument } = this
    let content = textDocument.getText()
    if (extraChars && extraChars.length) {
      let codes = []
      let keywordOption = '@,'
      for (let i = 0; i < extraChars.length; i++) {
        codes.push(String(extraChars.charCodeAt(i)))
      }
      keywordOption += codes.join(',')
      chars = new Chars(keywordOption)
    }
    let start = position
    let end = position
    let offset = textDocument.offsetAt(position)
    for (let i = offset - 1; i >= 0; i--) {
      if (i == 0) {
        start = textDocument.positionAt(0)
        break
      } else if (!chars.isKeywordChar(content[i])) {
        start = textDocument.positionAt(i + 1)
        break
      }
    }
    for (let i = offset; i <= content.length; i++) {
      if (i === content.length) {
        end = textDocument.positionAt(i)
        break
      } else if (!chars.isKeywordChar(content[i])) {
        end = textDocument.positionAt(i)
        break
      }
    }
    return { start, end }
  }

  private includeDash(filetype): boolean {
    return [
      'json',
      'html',
      'wxml',
      'css',
      'less',
      'scss',
      'wxss'
    ].indexOf(filetype) != -1
  }

  private async gitCheck(): Promise<void> {
    let { uri } = this
    if (!uri.startsWith('file://')) return
    let filepath = Uri.parse(uri).fsPath
    this.isIgnored = await isGitIgnored(filepath)
  }

  private createDocument(changeCount = 1): void {
    let { version, uri, filetype } = this
    version = version + changeCount
    this.textDocument = TextDocument.create(uri, filetype, version, this.lines.join('\n'))
  }

  private async _fetchContent(): Promise<void> {
    let { nvim, buffer } = this
    let { id } = buffer
    let o = await nvim.call('coc#util#get_content', [id]) as any
    if (!o) return
    let { content, changedtick } = o
    this._changedtick = changedtick
    this.lines = content.split('\n')
    this.fireContentChanges()
  }

  public patchChange(change: ChangeInfo): void {
    let { lines } = this
    let { lnum, line, changedtick } = change
    this._changedtick = changedtick
    lines[lnum - 1] = line
    this.fireContentChanges()
  }

  public fixStartcol(position: Position, valids: string[]): number {
    let line = this.getline(position.line)
    if (!line) return null
    let { character } = position
    let start = line.slice(0, character)
    let col = byteLength(start)
    let { chars } = this
    for (let i = start.length - 1; i >= 0; i--) {
      let c = start[i]
      if (c == ' ') break
      if (!chars.isKeywordChar(c) && valids.indexOf(c) === -1) {
        break
      }
      col = col - byteLength(c)
    }
    return col
  }
}

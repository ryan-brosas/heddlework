import React, { useEffect, useMemo, useState } from 'react'
import type { WorkbenchController } from '../workbench/controller.ts'
import type { WorkspaceDiff, WorkspaceDiffFile } from '../workbench/state.ts'
import { Icon } from './icons.tsx'
import { IconButton, NativeVirtualList, useNativeVirtualWindow } from './primitives.tsx'
import { RightPanelHeader, rightPanelStyle } from './right-panel-header.tsx'
import { colors, nativeTheme } from './theme.ts'
import { LAYOUT_MOTION_TRANSITION, MotionDiv, SPRING_SETTLE_MS } from './motion.ts'

export const DiffPanel = React.memo(function DiffPanel({
  diff,
  controller,
  fullscreen,
  fullscreenProgress,
  fullscreenLocked = false,
  panelWidth,
  onClose,
  onNewSurface,
  onToggleFullscreen,
}: {
  diff: WorkspaceDiff
  controller: WorkbenchController
  fullscreen: boolean
  fullscreenProgress: number
  fullscreenLocked?: boolean
  panelWidth?: number
  appearance?: 'light' | 'dark'
  onClose(): void
  onNewSurface(): void
  onToggleFullscreen(): void
}) {
  const [filesOpen, setFilesOpen] = useState(false)
  const [fileListMounted, setFileListMounted] = useState(false)
  const [wordWrap, setWordWrap] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | undefined>()
  useEffect(() => {
    if (filesOpen) return
    const timer = setTimeout(() => setFileListMounted(false), SPRING_SETTLE_MS - 32)
    return () => clearTimeout(timer)
  }, [filesOpen])
  useEffect(() => {
    if (selectedPath && !diff.files.some((file) => file.path === selectedPath)) setSelectedPath(undefined)
  }, [diff.files, selectedPath])
  const selectedFile = selectedPath ? diff.files.find((file) => file.path === selectedPath) : undefined
  const patch = useMemo(() => selectedFile?.patch ?? diff.files.map((file) => file.patch).join('\n'), [diff.files, selectedFile])
  const additions = selectedFile?.additions ?? diff.additions
  const deletions = selectedFile?.deletions ?? diff.deletions
  const canvasWidth = useMemo(() => diffCanvasWidth(patch), [patch])

  return (
    <div testId="diff-panel" style={rightPanelStyle(fullscreen, panelWidth)}>
      <RightPanelHeader
        icon="fileDiff"
        title="Diff"
        fullscreen={fullscreen}
        fullscreenProgress={fullscreenProgress}
        fullscreenLocked={fullscreenLocked}
        refreshDisabled={diff.status === 'loading'}
        onNew={onNewSurface}
        onRefresh={() => void controller.refreshWorkspaceDiff()}
        onToggleFullscreen={onToggleFullscreen}
        onClose={onClose}
      />
      <div style={{ height: 42, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 10, paddingRight: 10, borderWidth: 1, borderColor: colors.border }}>
        <div style={{ height: 28, minWidth: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 9, paddingRight: 8, borderRadius: 8, backgroundColor: colors.raised }}>
          <text style={{ color: colors.text, fontSize: 11, fontWeight: 550, fontFamily: nativeTheme.fontMono, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{selectedFile?.path ?? 'Working tree'}</text>
          <Icon name="chevronDown" size={10} color={colors.textFaint} />
        </div>
        <div style={{ flexGrow: 1 }} />
        {diff.files.length > 0 && (
          <>
            <text style={{ color: colors.success, fontSize: 10, fontFamily: nativeTheme.fontMono }}>{`+${additions}`}</text>
            <text style={{ color: colors.error, fontSize: 10, fontFamily: nativeTheme.fontMono }}>{`−${deletions}`}</text>
          </>
        )}
        <IconButton icon="wrap" label={wordWrap ? 'Disable line wrapping' : 'Enable line wrapping'} testId="diff-wrap-toggle" active={wordWrap} onClick={() => setWordWrap((value) => !value)} />
        <IconButton icon="list" label="Toggle changed files" testId="diff-file-list" active={filesOpen} onClick={() => {
          if (!filesOpen) setFileListMounted(true)
          setFilesOpen(!filesOpen)
        }} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'row', flexGrow: 1, minHeight: 0 }}>
        {(filesOpen || fileListMounted) && (
          <MotionDiv initial={{ width: 0 }} animate={{ width: filesOpen ? 212 : 0 }} transition={LAYOUT_MOTION_TRANSITION} testId="diff-file-list-host" style={{ position: 'relative', width: filesOpen ? 212 : 0, flexShrink: 0, minHeight: 0, overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: 212, display: 'flex' }}>
              <DiffFileList files={diff.files} selectedPath={selectedPath} onSelect={setSelectedPath} />
            </div>
          </MotionDiv>
        )}
        <div testId="diff-content" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, minHeight: 0, fontFamily: nativeTheme.fontMono }}>
          {diff.status === 'loading' ? (
            <PanelMessage icon="refresh" title="Loading working tree diff…" />
          ) : diff.status === 'error' ? (
            <PanelMessage icon="fileDiff" title="Diff unavailable" detail={cleanError(diff.error ?? '')} />
          ) : diff.files.length === 0 ? (
            <PanelMessage icon="check" title="No net changes in this selection." />
          ) : wordWrap ? (
            <WrappedDiff patch={patch} />
          ) : (
            <NativeDiffViewport patch={patch} files={selectedFile ? [selectedFile] : diff.files} canvasWidth={canvasWidth} />
          )}
        </div>
      </div>
    </div>
  )
}, (previous, next) => previous.diff === next.diff
  && previous.controller === next.controller
  && previous.fullscreen === next.fullscreen
  && previous.fullscreenProgress === next.fullscreenProgress
  && previous.fullscreenLocked === next.fullscreenLocked
  && previous.panelWidth === next.panelWidth
  // The body paints from the module-level palette that applyResolvedTheme mutates in place,
  // so a light/dark switch must break memo here even though the prop is never read directly.
  && previous.appearance === next.appearance)

const DIFF_HUNK_HEIGHT = 28
const DIFF_NOTICE_HEIGHT = 24
const DIFF_BODY_PAD = 8

interface DiffSection {
  file: WorkspaceDiffFile
  start: number
  end: number
}

interface DiffLayoutRow {
  key: string
  file: WorkspaceDiffFile
  kind: 'header' | 'hunk' | 'notice' | 'line'
  top: number
  height: number
  oldLine?: number | undefined
  newLine?: number | undefined
  marker?: string
  tone?: 'normal' | 'add' | 'delete'
}

interface DiffLayout {
  rows: DiffLayoutRow[]
  sections: DiffSection[]
  truncated: boolean
}

export function NativeDiffViewport({ patch }: { patch: string; files: WorkspaceDiffFile[]; canvasWidth: number }) {
  return (
    <div testId="diff-native-viewport" style={{ display: 'flex', flexGrow: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
      <diff
        testId="diff-native"
        patch={patch}
        scroll
        wordDiff
        theme={nativeTheme}
        style={{ width: '100%', height: '100%', flexGrow: 1, minWidth: 0, minHeight: 0, fontFamily: nativeTheme.fontMono }}
      />
    </div>
  )
}

export function diffSections(files: WorkspaceDiffFile[]): DiffSection[] {
  return buildDiffLayout(files).sections
}

function buildDiffLayout(files: WorkspaceDiffFile[], lineLimit = Number.POSITIVE_INFINITY): DiffLayout {
  const rows: DiffLayoutRow[] = []
  const sections: DiffSection[] = []
  let cursor = 0
  let renderedLines = 0
  let truncated = false
  for (const file of files) {
    const start = cursor
    rows.push({ key: `${file.path}:header`, file, kind: 'header', top: cursor, height: nativeTheme.metrics.diffFileHeaderHeight })
    cursor += nativeTheme.metrics.diffFileHeaderHeight
    let oldLine: number | undefined
    let newLine: number | undefined
    let inHunk = false
    let noticeCount = diffNoticeCount(file.patch)
    for (let index = 0; index < noticeCount; index += 1) {
      rows.push({ key: `${file.path}:notice:${index}`, file, kind: 'notice', top: cursor, height: DIFF_NOTICE_HEIGHT })
      cursor += DIFF_NOTICE_HEIGHT
    }
    for (const [index, line] of indexedPatchLines(file.patch)) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (hunk) {
        oldLine = Number(hunk[1])
        newLine = Number(hunk[2])
        inHunk = true
        rows.push({ key: `${file.path}:hunk:${index}`, file, kind: 'hunk', top: cursor, height: DIFF_HUNK_HEIGHT })
        cursor += DIFF_HUNK_HEIGHT
        continue
      }
      if (!inHunk) continue
      if (line.startsWith('+') && !line.startsWith('+++')) {
        if (renderedLines >= lineLimit) { truncated = true; break }
        rows.push({ key: `${file.path}:line:${index}`, file, kind: 'line', top: cursor, height: nativeTheme.metrics.diffLineHeight, newLine, marker: '+', tone: 'add' })
        if (newLine !== undefined) newLine += 1
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        if (renderedLines >= lineLimit) { truncated = true; break }
        rows.push({ key: `${file.path}:line:${index}`, file, kind: 'line', top: cursor, height: nativeTheme.metrics.diffLineHeight, oldLine, marker: '−', tone: 'delete' })
        if (oldLine !== undefined) oldLine += 1
      } else if (line.startsWith(' ')) {
        if (renderedLines >= lineLimit) { truncated = true; break }
        rows.push({ key: `${file.path}:line:${index}`, file, kind: 'line', top: cursor, height: nativeTheme.metrics.diffLineHeight, oldLine, newLine, marker: '·', tone: 'normal' })
        if (oldLine !== undefined) oldLine += 1
        if (newLine !== undefined) newLine += 1
      } else if (line.startsWith('\\')) {
        if (renderedLines >= lineLimit) { truncated = true; break }
        rows.push({ key: `${file.path}:line:${index}`, file, kind: 'line', top: cursor, height: nativeTheme.metrics.diffLineHeight, marker: '', tone: 'normal' })
      } else if (line.startsWith('diff --git ')) {
        inHunk = false
        continue
      } else {
        continue
      }
      cursor += nativeTheme.metrics.diffLineHeight
      renderedLines += 1
    }
    cursor += DIFF_BODY_PAD
    sections.push({ file, start, end: cursor })
    if (truncated) break
  }
  return { rows, sections, truncated }
}

function* indexedPatchLines(patch: string): Generator<[number, string]> {
  let start = 0
  let index = 0
  while (start <= patch.length) {
    const newline = patch.indexOf('\n', start)
    if (newline === -1) {
      yield [index, patch.slice(start)]
      return
    }
    yield [index, patch.slice(start, newline)]
    start = newline + 1
    index += 1
  }
}

function diffNoticeCount(patch: string): number {
  const added = patch.includes('\nnew file mode ')
  const deleted = patch.includes('\ndeleted file mode ')
  const renamed = patch.includes('\nrename from ') || patch.includes('\nrename to ')
  const binary = patch.includes('\nBinary files ') || patch.includes('\nGIT binary patch')
  const modeChanges = patch.match(/^new mode /gm)?.length ?? 0
  return Number(added) + Number(deleted) + Number(renamed) + Number(binary) + modeChanges
}

function DiffFileList({ files, selectedPath, onSelect }: { files: WorkspaceDiffFile[]; selectedPath: string | undefined; onSelect(path: string | undefined): void }) {
  const entries: Array<WorkspaceDiffFile | undefined> = [undefined, ...files]
  const selectedIndex = selectedPath ? Math.max(0, entries.findIndex((file) => file?.path === selectedPath)) : 0
  const virtualWindow = useNativeVirtualWindow(entries.length, `diff-files:${files.length}:${selectedPath ?? 'all'}`, Math.max(0, selectedIndex - 80))
  const visibleEntries = entries.slice(virtualWindow.windowStart, virtualWindow.windowEnd)
  return (
    <div testId="diff-file-list-panel" style={{ width: 212, flexGrow: 1, flexShrink: 0, minHeight: 0, display: 'flex', flexDirection: 'column', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel }}>
      <NativeVirtualList alignment="top" estimatedItemHeight={40} overdraw={160} itemCount={entries.length} windowStart={virtualWindow.windowStart} onVisibleRange={virtualWindow.onVisibleRange} style={{ flexGrow: 1, minHeight: 0, width: '100%', padding: 6 }}>
        {visibleEntries.map((file, visibleIndex) => file
          ? <DiffFileRow key={file.path} label={file.path} active={file.path === selectedPath} additions={file.additions} deletions={file.deletions} onClick={() => onSelect(file.path)} />
          : <DiffFileRow key={`all-${virtualWindow.windowStart + visibleIndex}`} label="All changes" active={!selectedPath} additions={files.reduce((sum, entry) => sum + entry.additions, 0)} deletions={files.reduce((sum, entry) => sum + entry.deletions, 0)} onClick={() => onSelect(undefined)} />)}
      </NativeVirtualList>
    </div>
  )
}

function DiffFileRow({ label, active, additions, deletions, onClick }: { label: string; active: boolean; additions: number; deletions: number; onClick(): void }) {
  return (
    <div testId="diff-file-row" tabIndex={0} style={{ height: 40, minWidth: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 8, paddingRight: 7, borderRadius: 7, backgroundColor: active ? colors.raised : colors.transparent, cursor: 'pointer', hover: { backgroundColor: colors.hover } }} onClick={onClick} onKeyDown={(event) => { if (event.key === 'enter') onClick() }}>
      <Icon name="fileDiff" size={13} color={active ? colors.textMuted : colors.textFaint} />
      <text style={{ color: active ? colors.text : colors.textMuted, fontSize: 11, minWidth: 0, flexGrow: 1, whiteSpace: 'nowrap', textOverflow: 'ellipsis', fontFamily: nativeTheme.fontMono }}>{label}</text>
      {additions > 0 && <text style={{ color: colors.success, fontSize: 10, fontFamily: nativeTheme.fontMono }}>{`+${additions}`}</text>}
      {deletions > 0 && <text style={{ color: colors.error, fontSize: 10, fontFamily: nativeTheme.fontMono }}>{`−${deletions}`}</text>}
    </div>
  )
}

interface WrappedLine {
  key: string
  oldLine: number | undefined
  newLine: number | undefined
  marker: string
  text: string
  tone: 'normal' | 'add' | 'delete' | 'hunk' | 'file'
}

const WRAPPED_PAGE_SIZE = 400

export function WrappedDiff({ patch }: { patch: string }) {
  const rows = useMemo(() => parseWrappedDiff(patch).slice(0, 2_000), [patch])
  const [visibleRows, setVisibleRows] = useState(WRAPPED_PAGE_SIZE)
  useEffect(() => setVisibleRows(WRAPPED_PAGE_SIZE), [patch])
  const displayedRows = rows.slice(0, visibleRows)
  return (
    <div testId="diff-wrapped-viewport" style={{ width: '100%', minWidth: 0, minHeight: 0, flexGrow: 1, display: 'flex', overflow: 'hidden' }}>
    <NativeVirtualList testId="diff-wrapped-scroll" alignment="top" estimatedItemHeight={19} overdraw={300} style={{ width: '100%', flexGrow: 1, minHeight: 0, minWidth: 0, alignSelf: 'stretch', backgroundColor: colors.background, userSelect: 'text', selectionColor: `${colors.primary}66` }}>
      {displayedRows.map((row) => {
        const background = row.tone === 'add' ? colors.diffAdd : row.tone === 'delete' ? colors.diffDel : row.tone === 'hunk' ? colors.diffHunkBg : colors.transparent
        const foreground = row.tone === 'hunk' ? colors.textMuted : row.tone === 'file' ? colors.text : nativeTheme.codeText
        return (
          <React.Fragment key={row.key}>
            <div testId={`diff-wrapped-row:${row.tone}`} style={{ width: '100%', minWidth: 0, minHeight: 19, flexShrink: 0, alignSelf: 'stretch', display: 'flex', flexDirection: 'row', alignItems: 'flex-start', backgroundColor: background }}>
              <text style={{ width: 38, flexShrink: 0, color: colors.textFaint, fontSize: 10, lineHeight: 19, textAlign: 'right', fontFamily: nativeTheme.fontMono }}>{row.oldLine ?? ''}</text>
              <text style={{ width: 38, flexShrink: 0, color: colors.textFaint, fontSize: 10, lineHeight: 19, textAlign: 'right', fontFamily: nativeTheme.fontMono }}>{row.newLine ?? ''}</text>
              <text style={{ width: 18, flexShrink: 0, color: row.tone === 'add' ? colors.success : row.tone === 'delete' ? colors.error : colors.textFaint, fontSize: 11, lineHeight: 19, textAlign: 'center', fontFamily: nativeTheme.fontMono }}>{row.marker}</text>
              <text testId="diff-wrapped-code" style={{ minWidth: 0, flexGrow: 1, paddingRight: 10, color: foreground, fontSize: 12, lineHeight: 19, whiteSpace: 'normal', fontFamily: nativeTheme.fontMono }}>{row.text || ' '}</text>
            </div>
          </React.Fragment>
        )
      })}
      {visibleRows < rows.length && (
        <div testId="diff-wrapped-show-more" tabIndex={0} style={{ height: 34, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.textMuted, backgroundColor: colors.raised, cursor: 'pointer', hover: { backgroundColor: colors.hover } }} onClick={() => setVisibleRows((count) => Math.min(rows.length, count + WRAPPED_PAGE_SIZE))}>
          <text style={{ color: colors.textMuted, fontSize: 10, fontFamily: nativeTheme.fontMono }}>{`Show ${Math.min(WRAPPED_PAGE_SIZE, rows.length - visibleRows)} more lines`}</text>
        </div>
      )}
    </NativeVirtualList>
    </div>
  )
}

export function parseWrappedDiff(patch: string): WrappedLine[] {
  let oldLine: number | undefined
  let newLine: number | undefined
  return patch.split('\n').map((line, index) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      return { key: `${index}:hunk`, oldLine: undefined, newLine: undefined, marker: '·', text: line, tone: 'hunk' }
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      const row = { key: `${index}:add`, oldLine: undefined, newLine, marker: '+', text: line.slice(1), tone: 'add' as const }
      if (newLine !== undefined) newLine += 1
      return row
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      const row = { key: `${index}:delete`, oldLine, newLine: undefined, marker: '−', text: line.slice(1), tone: 'delete' as const }
      if (oldLine !== undefined) oldLine += 1
      return row
    }
    if (line.startsWith(' ')) {
      const row = { key: `${index}:normal`, oldLine, newLine, marker: ' ', text: line.slice(1), tone: 'normal' as const }
      if (oldLine !== undefined) oldLine += 1
      if (newLine !== undefined) newLine += 1
      return row
    }
    return { key: `${index}:file`, oldLine: undefined, newLine: undefined, marker: '·', text: line, tone: 'file' }
  })
}

function diffCanvasWidth(patch: string): number {
  let longest = 0
  let scanned = 0
  for (const [, line] of indexedPatchLines(patch)) {
    longest = Math.max(longest, [...line].length)
    scanned += 1
    if (scanned >= 2_000) break
  }
  return Math.max(840, Math.min(16_000, 112 + longest * 7.4))
}

function PanelMessage({ icon, title, detail }: { icon: 'refresh' | 'fileDiff' | 'check'; title: string; detail?: string }) {
  return (
    <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, paddingLeft: 30, paddingRight: 30 }}>
      <Icon name={icon} size={18} color={colors.textFaint} />
      <text style={{ color: colors.textFaint, fontSize: 11, textAlign: 'center', fontFamily: nativeTheme.fontMono }}>{title}</text>
      {detail && <text style={{ color: colors.textFaint, fontSize: 9, lineHeight: 14, textAlign: 'center', lineClamp: 3, fontFamily: nativeTheme.fontMono }}>{detail}</text>}
    </div>
  )
}

function cleanError(error: string): string {
  const firstLine = error.split('\n').find(Boolean) ?? error
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine
}

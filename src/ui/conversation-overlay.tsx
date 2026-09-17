import { useEffect, useMemo, useRef, useState } from 'react'
import { useGpuixRequired } from '@gpuix/react'
import {
  cycleSessionTreeFilterMode,
  layoutSessionTreeOptions,
  PI_SESSION_TREE_FILTER_MODES,
  sessionTreeFilterLabel,
  type PiSessionTreeFilterMode,
  type PiSessionTreeRow,
} from '../pi/session-tree.ts'
import type { WorkbenchService } from '../workbench/controller.ts'
import {
  questionnaireFromTool,
  questionnaireMatchesDialog,
  type AskUserQuestion,
  type AskUserQuestionnaire,
  type AskUserSubmissionAnswer,
} from '../workbench/ask-user.ts'
import type { ExtensionDialog, WorkbenchState } from '../workbench/state.ts'
import { Button, NativeVirtualList, useNativeVirtualWindow, type NativeElementHandle } from './primitives.tsx'
import { colors, nativeTheme } from './theme.ts'
import { filterExtensionOptions, parseExtensionOption, parseExtensionTitle, type ParsedExtensionOption } from './extension-ui.ts'
import { useExternalLink } from './external-launch.ts'
import { useResponsiveLayout } from './responsive.tsx'

interface ExtensionDialogResponse {
  value?: string
  confirmed?: boolean
  cancelled?: boolean
}

interface AnswerDraft {
  kind: 'none' | 'option' | 'multi' | 'custom'
  optionIndex: number | undefined
  optionIndices: number[]
  custom: string
}

export function ConversationExtensionOverlay({ state, controller }: { state: WorkbenchState; controller: WorkbenchService }) {
  const { mobile } = useResponsiveLayout()
  const questionnaire = useMemo(() => {
    const candidates = state.liveTools.flatMap((tool) => {
      const parsed = questionnaireFromTool(tool)
      return parsed ? [parsed] : []
    })
    return candidates.find((candidate) => (
      candidate.toolCallId === state.questionnaireSubmitting
      || candidate.toolCallId === state.questionnaireCollapsed
      || questionnaireMatchesDialog(candidate, state.dialog)
    ))
  }, [state.dialog, state.liveTools, state.questionnaireCollapsed, state.questionnaireSubmitting])
  if (questionnaire && questionnaire.toolCallId === state.questionnaireCollapsed) return null
  if (!questionnaire && !state.dialog) return null
  return (
    <div
      testId="conversation-extension-overlay"
      style={{
        position: 'absolute',
        ...(questionnaire
          ? { top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.background }
          : { top: mobile ? 8 : 12, right: mobile ? 8 : 16, bottom: mobile ? 8 : 12, left: mobile ? 8 : 16 }),
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: questionnaire ? 'center' : 'flex-end',
        pointerEvents: 'none',
      }}
    >
      {questionnaire
        ? <QuestionnaireOverlay key={questionnaire.toolCallId} questionnaire={questionnaire} submitting={state.questionnaireSubmitting === questionnaire.toolCallId} controller={controller} />
        : state.dialog
          ? <GenericDialogSurface dialog={state.dialog} queued={state.dialogQueue.length} onRespond={(response) => controller.respondToDialog(response)} />
          : null}
    </div>
  )
}

function GenericDialogSurface({ dialog, queued, onRespond }: { dialog: ExtensionDialog; queued: number; onRespond(response: ExtensionDialogResponse): void }) {
  return (
    <div testId="extension-dialog-transition" style={{ position: 'relative', pointerEvents: 'auto', width: '100%', maxWidth: 820, maxHeight: '92%', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <GenericDialog dialog={dialog} interactive queued={queued} onRespond={onRespond} />
    </div>
  )
}

function QuestionnaireOverlay({ questionnaire, submitting, controller }: { questionnaire: AskUserQuestionnaire; submitting: boolean; controller: WorkbenchService }) {
  const { mobile } = useResponsiveLayout()
  const [currentTab, setCurrentTab] = useState(0)
  const [drafts, setDrafts] = useState<AnswerDraft[]>(() => questionnaire.questions.map((question) => ({
    kind: question.multiSelect ? 'multi' : 'none',
    optionIndex: undefined,
    optionIndices: [],
    custom: '',
  })))
  const submitTab = questionnaire.questions.length
  const complete = drafts.every((draft, index) => questionnaire.questions[index]?.multiSelect || draft.kind === 'option' || (draft.kind === 'custom' && draft.custom.trim().length > 0))

  const updateDraft = (index: number, update: (draft: AnswerDraft) => AnswerDraft) => {
    setDrafts((current) => current.map((draft, candidate) => candidate === index ? update(draft) : draft))
  }
  const submit = () => {
    if (!complete || submitting) return
    const answers: AskUserSubmissionAnswer[] = questionnaire.questions.map((question, index) => {
      const draft = drafts[index]!
      if (draft.kind === 'custom') return { kind: 'custom', value: draft.custom }
      if (question.multiSelect) return { kind: 'multi', optionIndices: draft.optionIndices }
      return { kind: 'option', optionIndex: draft.optionIndex! }
    })
    controller.submitAskUserQuestionnaire(questionnaire.toolCallId, answers)
  }

  const activeQuestion = currentTab < submitTab ? questionnaire.questions[currentTab] : undefined
  return (
    <div testId="ask-user-overlay" style={{ pointerEvents: 'auto', width: '100%', height: '100%', maxWidth: 1040, minWidth: 0, display: 'flex', flexDirection: 'column', borderRadius: 9, borderWidth: 0, backgroundColor: colors.background, overflow: 'hidden' }}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 62, paddingLeft: mobile ? 14 : 20, paddingRight: mobile ? 8 : 12, borderBottomWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.background }}>
        <div style={{ minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <text style={{ color: colors.warning, fontSize: 9, fontWeight: 750 }}>ASK USER QUESTION</text>
          <text style={{ color: colors.text, fontSize: 13, fontWeight: 650 }}>The agent needs a decision before it can continue</text>
        </div>
        <Button label="Hide" compact tone="quiet" onClick={() => controller.setAskUserQuestionnaireCollapsed(questionnaire.toolCallId, true)} testId="ask-user-collapse" />
      </div>

      <QuestionTabs questionnaire={questionnaire} currentTab={currentTab} drafts={drafts} onChange={setCurrentTab} />

      {activeQuestion
        ? <QuestionPage question={activeQuestion} index={currentTab} draft={drafts[currentTab]!} onChange={(update) => updateDraft(currentTab, update)} />
        : <QuestionnaireReview questionnaire={questionnaire} drafts={drafts} complete={complete} onSelect={setCurrentTab} />}

      <div style={{ minHeight: 56, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 14, paddingRight: 14, borderTopWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.background }}>
        <Button label="Cancel" compact tone="quiet" disabled={submitting} onClick={() => controller.cancelAskUserQuestionnaire(questionnaire.toolCallId)} />
        <div style={{ flexGrow: 1 }} />
        {currentTab > 0 && <Button label="Back" compact onClick={() => setCurrentTab((value) => Math.max(0, value - 1))} />}
        {currentTab < submitTab
          ? <Button label={currentTab === submitTab - 1 ? 'Review' : 'Next'} compact tone="primary" onClick={() => setCurrentTab((value) => Math.min(submitTab, value + 1))} />
          : <Button label={submitting ? 'Sending…' : 'Submit answers'} compact tone="primary" disabled={!complete || submitting} onClick={submit} testId="ask-user-submit" />}
      </div>
    </div>
  )
}

function QuestionTabs({ questionnaire, currentTab, drafts, onChange }: { questionnaire: AskUserQuestionnaire; currentTab: number; drafts: AnswerDraft[]; onChange(index: number): void }) {
  return (
    <div testId="ask-user-tabs" style={{ display: 'flex', flexDirection: 'row', gap: 0, minHeight: 46, paddingLeft: 16, paddingRight: 16, borderBottomWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.background, overflow: 'scroll' }}>
      {questionnaire.questions.map((question, index) => {
        const active = currentTab === index
        const answered = drafts[index]?.kind === 'option'
          || (drafts[index]?.kind === 'multi' && (drafts[index]?.optionIndices.length ?? 0) > 0)
          || (drafts[index]?.kind === 'custom' && Boolean(drafts[index]?.custom.trim()))
        return (
          <div key={`${index}-${question.header}`} testId={`ask-user-tab-${index}`} tabIndex={0} style={{ minWidth: 118, height: 46, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 10, paddingRight: 10, borderRadius: 0, borderWidth: 0, borderBottomWidth: active ? 2 : 0, borderColor: active ? colors.primary : colors.transparent, backgroundColor: colors.transparent, cursor: 'pointer' }} onClick={() => onChange(index)} onKeyDown={(event) => { if (event.key === 'enter' || event.key === 'space') onChange(index) }}>
            <text style={{ color: answered ? colors.success : colors.textFaint, fontSize: 10 }}>{answered ? '✓' : String(index + 1)}</text>
            <text style={{ color: active ? colors.text : colors.textMuted, fontSize: 10, fontWeight: active ? 650 : 500, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{question.header}</text>
          </div>
        )
      })}
      <div testId="ask-user-tab-submit" tabIndex={0} style={{ minWidth: 94, height: 46, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 0, borderWidth: 0, borderBottomWidth: currentTab === questionnaire.questions.length ? 2 : 0, borderColor: currentTab === questionnaire.questions.length ? colors.primary : colors.transparent, backgroundColor: colors.transparent, cursor: 'pointer' }} onClick={() => onChange(questionnaire.questions.length)} onKeyDown={(event) => { if (event.key === 'enter' || event.key === 'space') onChange(questionnaire.questions.length) }}>
        <text style={{ color: currentTab === questionnaire.questions.length ? colors.text : colors.textMuted, fontSize: 10, fontWeight: 600 }}>Submit</text>
      </div>
    </div>
  )
}

function QuestionPage({ question, index, draft, onChange }: { question: AskUserQuestion; index: number; draft: AnswerDraft; onChange(update: (draft: AnswerDraft) => AnswerDraft): void }) {
  const { mobile } = useResponsiveLayout()
  const link = useExternalLink()
  const hasPreviews = !question.multiSelect && question.options.some((option) => option.preview)
  const previewIndex = draft.kind === 'option' ? draft.optionIndex : question.options.findIndex((option) => option.preview)
  const preview = previewIndex === undefined || previewIndex < 0 ? undefined : question.options[previewIndex]?.preview
  const optionWindow = useNativeVirtualWindow(question.options.length, `ask-user:${index}:${question.header}:${question.options.length}`)
  const visibleOptions = question.options.slice(optionWindow.windowStart, optionWindow.windowEnd)
  return (
    <div style={{ minHeight: 0, flexGrow: 1, display: 'flex', flexDirection: mobile && hasPreviews ? 'column' : 'row', overflow: 'hidden' }}>
      <div style={{ width: mobile ? '100%' : hasPreviews ? '42%' : '100%', height: mobile && hasPreviews ? '58%' : 'auto', minWidth: mobile ? 0 : hasPreviews ? 280 : 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 0, paddingTop: mobile ? 14 : 18, paddingRight: mobile ? 14 : 18, paddingBottom: mobile ? 14 : 18, paddingLeft: mobile ? 14 : 18, borderRightWidth: hasPreviews && !mobile ? 1 : 0, borderBottomWidth: hasPreviews && mobile ? 1 : 0, borderColor: colors.borderStrong, backgroundColor: colors.background, overflow: 'hidden' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingBottom: 15 }}>
          <text style={{ color: colors.textFaint, fontSize: 9, fontWeight: 700 }}>{`QUESTION ${index + 1} · ${question.header.toUpperCase()}`}</text>
          <text testId="ask-user-question" style={{ color: colors.text, fontSize: 15, lineHeight: 22, fontWeight: 650, whiteSpace: 'normal' }}>{question.question}</text>
          {question.multiSelect && <text style={{ color: colors.textMuted, fontSize: 10 }}>Choose any number of options, or enter a custom answer.</text>}
        </div>
        <NativeVirtualList testId="ask-user-option-list" alignment="top" estimatedItemHeight={62} overdraw={186} itemCount={Math.max(1, question.options.length)} windowStart={optionWindow.windowStart} onVisibleRange={optionWindow.onVisibleRange} style={{ width: '100%', flexGrow: 1, minHeight: 0 }}>
        {visibleOptions.map((option, visibleIndex) => {
          const optionIndex = optionWindow.windowStart + visibleIndex
          const selected = draft.kind === 'option'
            ? draft.optionIndex === optionIndex
            : draft.kind === 'multi' && draft.optionIndices.includes(optionIndex)
          const choose = () => onChange((current) => {
            if (!question.multiSelect) return { ...current, kind: 'option', optionIndex, custom: '' }
            const present = current.kind === 'multi' ? current.optionIndices : []
            return {
              ...current,
              kind: 'multi',
              custom: '',
              optionIndex: undefined,
              optionIndices: present.includes(optionIndex) ? present.filter((value) => value !== optionIndex) : [...present, optionIndex],
            }
          })
          return <QuestionOption key={`${optionIndex}-${option.label}`} index={optionIndex} label={option.label} description={option.description} selected={selected} multi={question.multiSelect} onClick={choose} />
        })}
        </NativeVirtualList>
        <div testId="ask-user-custom-option" tabIndex={0} style={{ display: 'flex', flexDirection: 'column', gap: 7, minHeight: 48, paddingTop: 12, paddingRight: 10, paddingBottom: 12, paddingLeft: 10, borderRadius: 8, borderWidth: 0, borderBottomWidth: 0, backgroundColor: draft.kind === 'custom' ? colors.raised : colors.transparent, cursor: 'pointer', hover: { backgroundColor: colors.sidebarHover } }} onClick={() => onChange((current) => ({ ...current, kind: 'custom', optionIndex: undefined, optionIndices: [] }))} onKeyDown={(event) => { if (event.key === 'enter' || event.key === 'space') onChange((current) => ({ ...current, kind: 'custom', optionIndex: undefined, optionIndices: [] })) }}>
          <text style={{ color: draft.kind === 'custom' ? colors.text : colors.textMuted, fontSize: 11, fontWeight: 650 }}>Type something else</text>
          {draft.kind === 'custom' && (
            <textarea testId="ask-user-custom-input" value={draft.custom} placeholder="Enter your answer…" minRows={2} maxRows={5} autoFocus theme={nativeTheme} style={{ width: '100%', minWidth: 0, padding: 8, borderRadius: 7, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.input, color: colors.text, fontSize: 11, lineHeight: 17 }} onChange={(event) => onChange((current) => ({ ...current, custom: String(event.value ?? '') }))} />
          )}
        </div>
      </div>
      {hasPreviews && (
        <div testId="ask-user-preview" style={{ minWidth: 0, minHeight: 0, flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 10, padding: mobile ? 14 : 20, backgroundColor: colors.card, overflow: 'scroll' }}>
          <text style={{ color: colors.textFaint, fontSize: 9, fontWeight: 700 }}>PREVIEW</text>
          {preview
            ? <markdown source={preview} theme={questionnaireMarkdownTheme()} style={{ width: '100%', minWidth: 0 }} onLinkClick={(event) => link.open(String(event.value ?? ''))} />
            : <text style={{ color: colors.textFaint, fontSize: 11 }}>This option has no preview.</text>}
          {link.failure && <text testId="external-link-failure" style={{ color: colors.error, fontSize: 9 }}>{link.failure}</text>}
        </div>
      )}
    </div>
  )
}

function QuestionOption({ index, label, description, selected, multi, onClick }: { index: number; label: string; description: string; selected: boolean; multi: boolean; onClick(): void }) {
  return (
    <div testId={`ask-user-option-${index}`} tabIndex={0} style={{ minHeight: 62, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingTop: 12, paddingRight: 10, paddingBottom: 12, paddingLeft: 10, borderRadius: 8, borderWidth: 0, borderBottomWidth: 0, backgroundColor: selected ? colors.raised : colors.transparent, cursor: 'pointer', hover: { backgroundColor: colors.sidebarHover } }} onClick={onClick} onKeyDown={(event) => { if (event.key === 'enter' || event.key === 'space') onClick() }}>
      <div style={{ width: 20, height: 18, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-start' }}><text style={{ color: selected ? colors.info : colors.textFaint, fontSize: 9, fontWeight: selected ? 700 : 500 }}>{selected ? '✓' : multi ? '□' : String(index + 1).padStart(2, '0')}</text></div>
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <text style={{ color: selected ? colors.text : colors.textMuted, fontSize: 12, fontWeight: 650, whiteSpace: 'normal' }}>{label}</text>
        <text style={{ color: colors.textFaint, fontSize: 10, lineHeight: 15, whiteSpace: 'normal' }}>{description}</text>
      </div>
    </div>
  )
}

function QuestionnaireReview({ questionnaire, drafts, complete, onSelect }: { questionnaire: AskUserQuestionnaire; drafts: AnswerDraft[]; complete: boolean; onSelect(index: number): void }) {
  const reviewWindow = useNativeVirtualWindow(questionnaire.questions.length, `ask-user-review:${questionnaire.toolCallId}:${questionnaire.questions.length}`)
  const visibleQuestions = questionnaire.questions.slice(reviewWindow.windowStart, reviewWindow.windowEnd)
  return (
    <div testId="ask-user-review" style={{ minHeight: 0, flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 10, padding: 16, overflow: 'hidden' }}>
      <text style={{ color: colors.text, fontSize: 15, fontWeight: 650 }}>Review answers</text>
      {!complete && <text style={{ color: colors.warning, fontSize: 10 }}>Choose an answer for each single-choice question before submitting.</text>}
      <NativeVirtualList testId="ask-user-review-list" alignment="top" estimatedItemHeight={88} overdraw={176} itemCount={Math.max(1, questionnaire.questions.length)} windowStart={reviewWindow.windowStart} onVisibleRange={reviewWindow.onVisibleRange} style={{ width: '100%', flexGrow: 1, minHeight: 0 }}>
      {visibleQuestions.map((question, visibleIndex) => {
        const index = reviewWindow.windowStart + visibleIndex
        const draft = drafts[index]!
        const answer = draft.kind === 'option'
          ? question.options[draft.optionIndex!]?.label
          : draft.kind === 'custom'
            ? draft.custom.trim() || 'Unanswered'
            : draft.optionIndices.length > 0
              ? draft.optionIndices.map((optionIndex) => question.options[optionIndex]?.label).filter(Boolean).join(', ')
              : 'No options selected'
        return (
          <div key={`${index}-${question.question}`} testId={`ask-user-review-${index}`} tabIndex={0} style={{ display: 'flex', flexDirection: 'column', gap: 5, minHeight: 88, flexShrink: 0, paddingTop: 14, paddingRight: 10, paddingBottom: 14, paddingLeft: 10, borderRadius: 8, borderWidth: 0, borderBottomWidth: 0, backgroundColor: colors.transparent, cursor: 'pointer', hover: { backgroundColor: colors.sidebarHover } }} onClick={() => onSelect(index)} onKeyDown={(event) => { if (event.key === 'enter') onSelect(index) }}>
            <text style={{ color: colors.textFaint, fontSize: 9, fontWeight: 700 }}>{question.header.toUpperCase()}</text>
            <text style={{ color: colors.text, fontSize: 11, fontWeight: 600, whiteSpace: 'normal' }}>{question.question}</text>
            <text style={{ color: answer === 'Unanswered' ? colors.warning : colors.textMuted, fontSize: 11, whiteSpace: 'normal' }}>{answer}</text>
          </div>
        )
      })}
      </NativeVirtualList>
    </div>
  )
}

function GenericDialog({ dialog, interactive, queued, onRespond }: { dialog: ExtensionDialog; interactive: boolean; queued: number; onRespond(response: ExtensionDialogResponse): void }) {
  const [valueState, setValueState] = useState(() => ({ dialogId: dialog.id, value: dialog.prefill ?? '' }))
  const [queryState, setQueryState] = useState(() => ({ dialogId: dialog.id, value: '' }))
  const [treeViewState, setTreeViewState] = useState<{ dialogId: string; filterMode: PiSessionTreeFilterMode; showLabelTimestamps: boolean }>(() => ({ dialogId: dialog.id, filterMode: 'default', showLabelTimestamps: false }))
  const value = valueState.dialogId === dialog.id ? valueState.value : dialog.prefill ?? ''
  const query = queryState.dialogId === dialog.id ? queryState.value : ''
  const treeView = treeViewState.dialogId === dialog.id ? treeViewState : { dialogId: dialog.id, filterMode: 'default' as const, showLabelTimestamps: false }
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (dialog.deadlineAt === undefined) return
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [dialog.deadlineAt])
  const title = parseExtensionTitle(dialog.title)
  const options = useMemo(() => (dialog.options ?? []).map(parseExtensionOption), [dialog.options])
  const filtered = useMemo(() => filterExtensionOptions(options, query), [options, query])
  const treeModeRows = useMemo(() => layoutSessionTreeOptions(dialog.treeOptions ?? [], '', treeView.filterMode), [dialog.treeOptions, treeView.filterMode])
  const treeRows = useMemo(() => query ? layoutSessionTreeOptions(dialog.treeOptions ?? [], query, treeView.filterMode) : treeModeRows, [dialog.treeOptions, query, treeModeRows, treeView.filterMode])
  const choiceCount = dialog.method === 'tree' ? dialog.treeOptions?.length ?? 0 : options.length
  const remaining = dialog.deadlineAt === undefined ? undefined : Math.max(0, Math.ceil((dialog.deadlineAt - now) / 1_000))
  const cancelLabel = title.title.includes('›') ? 'Back' : 'Cancel'
  const setTreeFilterMode = (filterMode: PiSessionTreeFilterMode) => setTreeViewState({ ...treeView, filterMode })
  const cycleTreeFilter = (direction: 1 | -1) => setTreeFilterMode(cycleSessionTreeFilterMode(treeView.filterMode, direction))
  const handleTreeSearchKeyDown = (event: { key?: string; ctrlKey?: boolean; shiftKey?: boolean; modifiers?: { ctrl?: boolean; shift?: boolean } }) => {
    const ctrl = event.modifiers?.ctrl ?? event.ctrlKey ?? false
    if (!ctrl) return
    const key = event.key?.toLowerCase()
    const shortcuts: Partial<Record<string, PiSessionTreeFilterMode>> = { d: 'default', t: 'no-tools', u: 'user-only', l: 'labeled-only', a: 'all' }
    if (key === 'o') cycleTreeFilter((event.modifiers?.shift ?? event.shiftKey) ? -1 : 1)
    else if (key && shortcuts[key]) setTreeFilterMode(shortcuts[key]!)
  }

  return (
    <div testId="extension-dialog" style={{ pointerEvents: interactive ? 'auto' : 'none', width: '100%', maxWidth: 820, maxHeight: '100%', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.card, overflow: 'hidden' }}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', minWidth: 0, gap: 9 }}>
        <div testId="extension-dialog-marker" style={{ width: 6, height: 6, marginTop: 6, flexShrink: 0, borderRadius: 3, backgroundColor: colors.warning }} />
        <div style={{ minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <text testId="extension-dialog-title" style={{ color: colors.text, fontSize: 13, fontWeight: 650, lineHeight: 18, minWidth: 0, width: '100%', whiteSpace: 'normal' }}>{title.title}</text>
          {title.detail && <text style={{ color: colors.textMuted, fontSize: 10, lineHeight: 15, width: '100%', maxHeight: 76, whiteSpace: 'normal', overflow: 'hidden' }}>{title.detail}</text>}
        </div>
        {(queued > 0 || remaining !== undefined) && <text style={{ color: colors.textFaint, fontSize: 9, flexShrink: 0 }}>{[queued > 0 ? `1 of ${queued + 1}` : '', remaining !== undefined ? `${remaining}s` : ''].filter(Boolean).join(' · ')}</text>}
      </div>
      {dialog.message && <text style={{ color: colors.textMuted, fontSize: 11, lineHeight: 17, minWidth: 0, width: '100%', whiteSpace: 'normal' }}>{dialog.message}</text>}
      {(dialog.method === 'select' || dialog.method === 'tree') && (
        <>
          {dialog.method === 'tree' && (
            <SessionTreeViewControls filterMode={treeView.filterMode} showLabelTimestamps={treeView.showLabelTimestamps} onFilterMode={setTreeFilterMode} onCycle={cycleTreeFilter} onToggleLabelTimestamps={() => setTreeViewState({ ...treeView, showLabelTimestamps: !treeView.showLabelTimestamps })} />
          )}
          {choiceCount > 5 && (
            <div testId="extension-dialog-search-frame" style={{ width: '100%', height: 34, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 10, paddingRight: 10, borderRadius: 7, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.input }}>
              <input testId="extension-dialog-search" value={query} placeholder={dialog.method === 'tree' ? 'Search session tree…' : 'Search choices…'} autoFocus theme={{ caret: colors.text, text: colors.text, textMuted: colors.textFaint, bg: colors.transparent }} style={{ minWidth: 0, height: 28, flexGrow: 1, borderWidth: 0, backgroundColor: colors.transparent, color: colors.text, fontSize: 11 }} onChange={(event) => setQueryState({ dialogId: dialog.id, value: String(event.value ?? '') })} {...(dialog.method === 'tree' ? { onKeyDown: handleTreeSearchKeyDown } : {})} />
            </div>
          )}
          {dialog.method === 'tree'
            ? <SessionTreeChoiceList dialogId={dialog.id} rows={treeRows} query={query} filterMode={treeView.filterMode} showLabelTimestamps={treeView.showLabelTimestamps} onRespond={onRespond} />
            : <ExtensionChoiceList dialogId={dialog.id} options={filtered} query={query} onRespond={onRespond} />}
          {dialog.method === 'tree' && <SessionTreeStatus rows={treeRows} modeCount={treeModeRows.length} totalCount={dialog.treeOptions?.length ?? 0} filterMode={treeView.filterMode} query={query} showLabelTimestamps={treeView.showLabelTimestamps} />}
          <div style={{ display: 'flex', flexDirection: 'row' }}><Button label={cancelLabel} tone="quiet" compact onClick={() => onRespond({ cancelled: true })} /></div>
        </>
      )}
      {dialog.method === 'confirm' && (
        <div style={{ display: 'flex', flexDirection: 'row', gap: 7 }}>
          <Button label="Confirm" tone="primary" onClick={() => onRespond({ confirmed: true })} />
          <Button label="Decline" onClick={() => onRespond({ confirmed: false })} />
          <Button label={cancelLabel} tone="quiet" onClick={() => onRespond({ cancelled: true })} />
        </div>
      )}
      {(dialog.method === 'input' || dialog.method === 'editor') && (
        <>
          <textarea testId="extension-dialog-input" value={value} placeholder={dialog.placeholder ?? ''} minRows={dialog.method === 'editor' ? 5 : 1} maxRows={dialog.method === 'editor' ? 12 : 4} autoFocus theme={nativeTheme} style={{ width: '100%', minWidth: 0, padding: 9, borderRadius: 7, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.input, color: colors.text, fontSize: 12, lineHeight: 18 }} onChange={(event) => setValueState({ dialogId: dialog.id, value: String(event.value ?? '') })} onSubmit={() => onRespond({ value })} />
          <div style={{ display: 'flex', flexDirection: 'row', gap: 7 }}>
            <Button label="Submit" tone="primary" onClick={() => onRespond({ value })} />
            <Button label={cancelLabel} tone="quiet" onClick={() => onRespond({ cancelled: true })} />
          </div>
        </>
      )}
    </div>
  )
}

const DIALOG_LIST_MAX_HEIGHT = 360
const EXTENSION_CHOICE_HEIGHT = 46
const SESSION_TREE_ROW_HEIGHT = 32
const SESSION_TREE_COLUMN_WIDTH = 16
const SESSION_TREE_MAX_VISIBLE_DEPTH = 10

function SessionTreeViewControls({
  filterMode,
  showLabelTimestamps,
  onFilterMode,
  onCycle,
  onToggleLabelTimestamps,
}: {
  filterMode: PiSessionTreeFilterMode
  showLabelTimestamps: boolean
  onFilterMode(mode: PiSessionTreeFilterMode): void
  onCycle(direction: 1 | -1): void
  onToggleLabelTimestamps(): void
}) {
  return (
    <div testId="session-tree-controls" style={{ width: '100%', minHeight: 30, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <text style={{ color: colors.textFaint, fontSize: 9, fontWeight: 700, marginRight: 2 }}>VIEW</text>
      <TreeControl label="‹" testId="session-tree-cycle-previous" onClick={() => onCycle(-1)} />
      {PI_SESSION_TREE_FILTER_MODES.map((mode) => <TreeControl key={mode} label={sessionTreeFilterLabel(mode)} testId={`session-tree-filter-${mode}`} active={mode === filterMode} onClick={() => onFilterMode(mode)} />)}
      <TreeControl label="›" testId="session-tree-cycle-next" onClick={() => onCycle(1)} />
      <div style={{ flexGrow: 1 }} />
      <TreeControl label="Label time" testId="session-tree-label-time" active={showLabelTimestamps} onClick={onToggleLabelTimestamps} />
    </div>
  )
}

function TreeControl({ label, testId, active = false, onClick }: { label: string; testId: string; active?: boolean; onClick(): void }) {
  return (
    <div testId={testId} tabIndex={0} style={{ height: 26, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingLeft: 7, paddingRight: 7, borderRadius: 6, borderWidth: 1, borderColor: active ? colors.borderStrong : colors.transparent, backgroundColor: active ? colors.raised : colors.transparent, cursor: 'pointer', hover: { backgroundColor: active ? colors.raised : colors.hover } }} onClick={onClick} onKeyDown={(event) => { if (event.key === 'enter' || event.key === 'space') onClick() }}>
      <text style={{ color: active ? colors.text : colors.textMuted, fontSize: 9, fontWeight: active ? 650 : 500, whiteSpace: 'nowrap' }}>{label}</text>
    </div>
  )
}

function SessionTreeStatus({ rows, modeCount, totalCount, filterMode, query, showLabelTimestamps }: { rows: PiSessionTreeRow[]; modeCount: number; totalCount: number; filterMode: PiSessionTreeFilterMode; query: string; showLabelTimestamps: boolean }) {
  const focusIndex = sessionTreeFocusIndex(rows)
  const parts = [`${rows.length === 0 ? 0 : focusIndex + 1}/${rows.length}`, sessionTreeFilterLabel(filterMode)]
  if (query) parts.push(`${rows.length} match${rows.length === 1 ? '' : 'es'}`)
  if (modeCount !== totalCount) parts.push(`${modeCount}/${totalCount} in view`)
  else if (totalCount > 0) parts.push(`${totalCount} total`)
  if (showLabelTimestamps) parts.push('label time')
  return <text testId="session-tree-status" style={{ color: colors.textFaint, fontSize: 9, lineHeight: 13 }}>{parts.join(' · ')}</text>
}

function sessionTreeFocusIndex(rows: readonly PiSessionTreeRow[]): number {
  const active = rows.findIndex((row) => row.active)
  if (active >= 0) return active
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.onActivePath) return index
  }
  return 0
}

function ExtensionChoiceList({ dialogId, options, query, onRespond }: { dialogId: string; options: ParsedExtensionOption[]; query: string; onRespond(response: ExtensionDialogResponse): void }) {
  const height = Math.min(DIALOG_LIST_MAX_HEIGHT, Math.max(36, options.length * EXTENSION_CHOICE_HEIGHT))
  const window = useNativeVirtualWindow(options.length, `${dialogId}:${query}:${options.length}`)
  const visibleOptions = options.slice(window.windowStart, window.windowEnd)
  return (
    <div key={dialogId} testId="extension-dialog-options" style={{ position: 'relative', width: '100%', height, minHeight: 0, flexShrink: 1, display: 'flex', overflow: 'hidden' }}>
      <NativeVirtualList testId="extension-dialog-option-list" alignment="top" estimatedItemHeight={EXTENSION_CHOICE_HEIGHT} overdraw={EXTENSION_CHOICE_HEIGHT * 3} itemCount={Math.max(1, options.length)} windowStart={window.windowStart} onVisibleRange={window.onVisibleRange} style={{ width: '100%', flexGrow: 1, minHeight: 0 }}>
        {options.length === 0
          ? <div key="empty" style={{ height: 36, flexShrink: 0, display: 'flex', alignItems: 'center', paddingLeft: 12 }}><text style={{ color: colors.textFaint, fontSize: 10 }}>No choices match your search.</text></div>
          : visibleOptions.map((option, visibleIndex) => {
            const index = window.windowStart + visibleIndex
            return <div key={`${index}-${option.value}`} testId={`extension-dialog-option-${index}`} tabIndex={0} style={{ height: EXTENSION_CHOICE_HEIGHT, flexShrink: 0, minWidth: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 9, paddingLeft: 9, paddingRight: 9, borderRadius: 8, borderWidth: 0, borderBottomWidth: 0, backgroundColor: colors.transparent, cursor: 'pointer', hover: { backgroundColor: colors.sidebarHover } }} onClick={() => onRespond({ value: option.value })} onKeyDown={(event) => { if (event.key === 'enter' || event.key === 'space') onRespond({ value: option.value }) }}>
              {option.ordinal && <text style={{ width: 19, color: colors.textFaint, fontSize: 10, flexShrink: 0 }}>{option.ordinal}</text>}
              <div style={{ minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2 }}>
                <text testId={`extension-dialog-option-label-${index}`} style={{ minWidth: 0, color: colors.text, fontSize: 11, lineHeight: 15, fontWeight: 600, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{option.label}</text>
                {option.detail && <text style={{ minWidth: 0, color: colors.textFaint, fontSize: 9, lineHeight: 13, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{option.detail}</text>}
              </div>
            </div>
          })}
      </NativeVirtualList>
    </div>
  )
}

function SessionTreeChoiceList({ dialogId, rows, query, filterMode, showLabelTimestamps, onRespond }: { dialogId: string; rows: PiSessionTreeRow[]; query: string; filterMode: PiSessionTreeFilterMode; showLabelTimestamps: boolean; onRespond(response: ExtensionDialogResponse): void }) {
  const renderer = useGpuixRequired()
  const listRef = useRef<NativeElementHandle>(null)
  const height = Math.min(DIALOG_LIST_MAX_HEIGHT, Math.max(36, rows.length * SESSION_TREE_ROW_HEIGHT))
  const overflow = rows.length * SESSION_TREE_ROW_HEIGHT > DIALOG_LIST_MAX_HEIGHT
  const focusIndex = sessionTreeFocusIndex(rows)
  const initialStart = Math.max(0, focusIndex - 159)
  const viewIdentity = `${dialogId}:${filterMode}:${query}:${rows.length}:${rows[0]?.entryId ?? ''}:${rows.at(-1)?.entryId ?? ''}`
  const window = useNativeVirtualWindow(rows.length, viewIdentity, initialStart)
  const visibleRows = rows.slice(window.windowStart, window.windowEnd)
  useEffect(() => {
    if (rows.length === 0) return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled || !listRef.current) return
      const bottomOffset = query ? 0 : -Math.max(0, height - SESSION_TREE_ROW_HEIGHT)
      renderer.scrollToItem?.(listRef.current.id, focusIndex, bottomOffset)
    })
    return () => { cancelled = true }
  }, [focusIndex, height, query, renderer, rows.length, viewIdentity])
  return (
    <div key={dialogId} testId="extension-dialog-options" style={{ position: 'relative', width: '100%', height, minHeight: 0, flexShrink: 1, display: 'flex', overflow: 'hidden' }}>
      <NativeVirtualList key={dialogId} testId="session-tree-list" elementRef={listRef} alignment={!query && overflow ? 'bottom' : 'top'} estimatedItemHeight={SESSION_TREE_ROW_HEIGHT} overdraw={SESSION_TREE_ROW_HEIGHT * 4} itemCount={Math.max(1, rows.length)} windowStart={window.windowStart} onVisibleRange={window.onVisibleRange} style={{ width: '100%', flexGrow: 1, minHeight: 0 }}>
        {rows.length === 0
          ? <div key="empty" style={{ height: 36, flexShrink: 0, display: 'flex', alignItems: 'center', paddingLeft: 12 }}><text style={{ color: colors.textFaint, fontSize: 10 }}>No entries match this search and view.</text></div>
          : visibleRows.map((row, visibleIndex) => {
            const index = window.windowStart + visibleIndex
            return <SessionTreeChoiceRow key={row.entryId} row={row} index={index} showLabelTimestamp={showLabelTimestamps} onClick={() => onRespond({ value: row.entryId })} />
          })}
      </NativeVirtualList>
    </div>
  )
}

function SessionTreeChoiceRow({ row, index, showLabelTimestamp, onClick }: { row: PiSessionTreeRow; index: number; showLabelTimestamp: boolean; onClick(): void }) {
  const depthOffset = Math.max(0, row.depth - SESSION_TREE_MAX_VISIBLE_DEPTH)
  const nodeColumn = row.depth - depthOffset
  const nodeX = nodeColumn * SESSION_TREE_COLUMN_WIDTH + SESSION_TREE_COLUMN_WIDTH / 2
  const railWidth = (nodeColumn + 1) * SESSION_TREE_COLUMN_WIDTH + 4
  const lineColor = row.onActivePath ? colors.primary : colors.borderStrong
  const parentColumn = row.connection === 'branch' ? row.depth - 1 : row.depth
  const parentX = (parentColumn - depthOffset) * SESSION_TREE_COLUMN_WIDTH + SESSION_TREE_COLUMN_WIDTH / 2
  const visibleGuides = row.guides.filter((column) => column >= depthOffset)
  const entryColor = sessionTreeEntryColor(row)
  const labelTimestamp = showLabelTimestamp && row.label && row.labelTimestamp !== undefined ? formatSessionTreeLabelTimestamp(row.labelTimestamp) : undefined
  return (
    <div testId={`session-tree-row-${index}`} tabIndex={0} style={{ height: SESSION_TREE_ROW_HEIGHT, flexShrink: 0, minWidth: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingRight: 8, borderRadius: 6, backgroundColor: row.active ? colors.raised : colors.transparent, cursor: 'pointer', hover: { backgroundColor: colors.sidebarHover } }} onClick={onClick} onKeyDown={(event) => { if (event.key === 'enter' || event.key === 'space') onClick() }}>
      <div testId={`session-tree-rail-${index}`} style={{ position: 'relative', width: railWidth, height: SESSION_TREE_ROW_HEIGHT, flexShrink: 0 }}>
        {visibleGuides.map((column) => {
          const x = (column - depthOffset) * SESSION_TREE_COLUMN_WIDTH + SESSION_TREE_COLUMN_WIDTH / 2
          return <div key={`guide-${column}`} style={{ position: 'absolute', left: x, top: 0, width: 1, height: SESSION_TREE_ROW_HEIGHT, backgroundColor: colors.borderStrong }} />
        })}
        {row.connection !== 'root' && !visibleGuides.includes(parentColumn) && parentX >= 0 && <div style={{ position: 'absolute', left: parentX, top: 0, width: 1, height: SESSION_TREE_ROW_HEIGHT / 2 + 1, backgroundColor: lineColor }} />}
        {row.connection === 'branch' && parentX >= 0 && <div style={{ position: 'absolute', left: parentX, top: SESSION_TREE_ROW_HEIGHT / 2, width: Math.max(1, nodeX - parentX), height: 1, backgroundColor: lineColor }} />}
        {row.hasChildren && <div style={{ position: 'absolute', left: nodeX, top: SESSION_TREE_ROW_HEIGHT / 2, width: 1, height: SESSION_TREE_ROW_HEIGHT / 2, backgroundColor: row.onActivePath ? colors.primary : colors.borderStrong }} />}
        <div testId={`session-tree-node-${index}`} style={{ position: 'absolute', left: nodeX - (row.active ? 4 : 3), top: SESSION_TREE_ROW_HEIGHT / 2 - (row.active ? 4 : 3), width: row.active ? 8 : 6, height: row.active ? 8 : 6, borderRadius: 4, borderWidth: row.onActivePath ? 0 : 1, borderColor: row.onActivePath ? colors.primary : colors.textFaint, backgroundColor: row.onActivePath ? colors.primary : colors.card }} />
      </div>
      <text testId={`session-tree-path-${index}`} style={{ width: 9, flexShrink: 0, color: colors.primary, fontSize: 10 }}>{row.onActivePath ? '•' : ''}</text>
      <text testId={`session-tree-kind-${index}`} style={{ width: 78, flexShrink: 0, color: entryColor, fontSize: 10, fontWeight: row.onActivePath ? 650 : 550, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{row.title}</text>
      <text testId={`session-tree-detail-${index}`} style={{ minWidth: 0, flexGrow: 1, color: row.active ? colors.text : colors.textMuted, fontSize: 10, fontWeight: row.active ? 600 : 400, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{row.detail || row.title}</text>
      {row.label && <text testId={`session-tree-label-${index}`} style={{ maxWidth: 150, flexShrink: 1, marginLeft: 8, paddingLeft: 6, paddingRight: 6, color: colors.warning, fontSize: 9, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{`[${row.label}]`}</text>}
      {labelTimestamp && <text testId={`session-tree-label-time-${index}`} style={{ flexShrink: 0, marginLeft: 4, color: colors.textFaint, fontSize: 9, whiteSpace: 'nowrap' }}>{labelTimestamp}</text>}
      {row.active && <text testId="session-tree-active" style={{ marginLeft: 8, flexShrink: 0, color: colors.primary, fontSize: 9, fontWeight: 700 }}>ACTIVE</text>}
    </div>
  )
}

function sessionTreeEntryColor(row: PiSessionTreeRow): string {
  if (row.kind === 'user') return colors.info
  if (row.kind === 'assistant') return colors.success
  if (row.kind === 'summary') return colors.warning
  if (row.kind === 'context') return colors.textMuted
  return colors.textFaint
}

function formatSessionTreeLabelTimestamp(value: string | number): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const now = new Date()
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()) return time
  const monthDay = `${date.getMonth() + 1}/${date.getDate()}`
  return date.getFullYear() === now.getFullYear() ? `${monthDay} ${time}` : `${String(date.getFullYear()).slice(-2)}/${monthDay} ${time}`
}

function questionnaireMarkdownTheme() {
  return {
    ...nativeTheme,
    text: colors.textMuted,
    textMuted: colors.textFaint,
    metrics: {
      ...nativeTheme.metrics,
      mdTextSize: 12,
      mdLineHeight: 19,
      mdBlockGap: 8,
      mdHeadingSizes: [14, 13, 12, 12],
      mdHeadingLineHeights: [21, 20, 19, 19],
      codeTextSize: 11,
      codeLineHeight: 18,
    },
  }
}

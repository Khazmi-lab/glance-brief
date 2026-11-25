// Domain types and the pluggable data-source interfaces.
// Everything in src/core is pure (no bridge, no network) so it is unit-testable.

export interface Meeting {
  id: string
  title: string
  start: Date
  end: Date
  location?: string
  /** Free-text description from the invite (may be long; summarised later). */
  description?: string
  attendees: string[]
  /** Attendee email addresses (not the user), used to find recent mail with the same people. */
  attendeeEmails?: string[]
  /** Hangouts/Meet/Zoom link if present. */
  joinUrl?: string
}

export interface EmailItem {
  id: string
  threadId: string
  /** Display name, or the address when no name is given. */
  from: string
  fromAddress: string
  subject: string
  snippet: string
  receivedAt: Date
}

export interface CalendarSource {
  /** Upcoming meetings starting after `now` (or in progress), soonest first. */
  upcoming(now: Date, limit: number): Promise<Meeting[]>
  /** Meetings that ended in the last `withinMin` minutes, most recent first (optional). */
  recentlyEnded?(now: Date, withinMin: number): Promise<Meeting[]>
}

export interface MailSource {
  /** Unread inbox messages, newest first. */
  unread(limit: number): Promise<EmailItem[]>
  /** Recent mail from/to these addresses (read-only metadata), newest first (optional). */
  withPeople?(addresses: string[], o: { days: number; limit: number }): Promise<EmailItem[]>
}

export interface Summarizer {
  /** One line (<= maxWords words) brief for a meeting. */
  meetingBrief(m: Meeting, maxWords: number): Promise<string>
  /** One line (<= maxWords words) summary of an email. */
  emailSummary(e: EmailItem, maxWords: number): Promise<string>
  /** Short reply draft for an email (one sentence). */
  replyDraft(e: EmailItem): Promise<string>
  /** Turn what the user dictated into a short reply. Must keep the meaning and add no facts. */
  polishReply(e: EmailItem, said: string): Promise<string>
  /** Up to `max` short "Name: open item" lines from recent mail with the meeting's attendees. */
  pendingItems(m: Meeting, emails: EmailItem[], max: number): Promise<string[]>
}

/** Speech-to-text. Production: the backend's allow-listed STT route (the key stays server-side). */
export interface SpeechToText {
  /** 16 kHz s16le mono PCM -> plain text ('' if nothing was understood). */
  transcribe(pcm: Uint8Array): Promise<string>
}

/** Microphone control (glasses mic via the Even Hub bridge in production). */
export interface Mic {
  open(): Promise<boolean>
  close(): Promise<void>
}

/** The only write path. Implementations must create a draft / send ONLY when called;
 *  the state machine calls it only after an explicit confirm tap. */
export interface ReplySink {
  saveReply(to: EmailItem, body: string): Promise<{ ok: boolean; detail: string; draftId?: string }>
}

/** A reply draft that Glance Brief itself created and that still exists (not sent, not deleted). */
export interface PendingDraft {
  id: string
  /** Recipient label for the glasses (name or address). */
  to: string
  subject: string
  createdAt: Date
}

/** Tracks ONLY drafts the app created. Production: the backend's ledger (it records draft ids
 *  on drafts.create and refuses to touch any other draft). Never sends. */
export interface DraftTracker {
  /** App-created drafts still waiting in Gmail Drafts, oldest first. */
  pending(): Promise<PendingDraft[]>
  /** Delete these app-created drafts (called only after a confirm tap). Returns how many were removed. */
  discard(ids: string[]): Promise<number>
  /** Local trackers (demo) record a just-saved draft; the backend records it itself. */
  noteSaved?(to: EmailItem, draftId: string | undefined, at: Date): void
}

export type DraftMoment = 'after_meeting' | 'end_of_day' | 'later'

export interface DraftsInfo {
  list: PendingDraft[]
  stale: PendingDraft[]
  /** Promoted to the first screen at a sensible moment, or shown at the end of the scroll. */
  moment: DraftMoment
}

export interface BriefCard {
  meeting?: Meeting
  meetingLine?: string
  emails: { item: EmailItem; summary: string }[]
  /** "Name: open item" lines from recent mail with the attendees (may be empty). */
  pending: string[]
  /** Set when the user is in a meeting and the focus meeting starts within B2B_GAP_MIN of its end. */
  backToBack?: { current: Meeting }
  drafts?: DraftsInfo
  /** True when built from labelled fixture/test data (shown on screen). */
  demo: boolean
  errors: string[]
}

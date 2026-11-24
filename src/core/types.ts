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
}

export interface MailSource {
  /** Unread inbox messages, newest first. */
  unread(limit: number): Promise<EmailItem[]>
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
  saveReply(to: EmailItem, body: string): Promise<{ ok: boolean; detail: string }>
}

export interface BriefCard {
  meeting?: Meeting
  meetingLine?: string
  emails: { item: EmailItem; summary: string }[]
  /** True when built from labelled fixture/test data (shown on screen). */
  demo: boolean
  errors: string[]
}

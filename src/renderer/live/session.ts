import {
  EndSensitivity,
  GoogleGenAI,
  Modality,
  StartSensitivity,
  type FunctionCall,
  type FunctionDeclaration,
  type FunctionResponse,
  type LiveServerMessage,
  type Session,
} from '@google/genai';

export type LiveState = 'connecting' | 'live' | 'reconnecting' | 'closed' | 'error';

export interface LiveCallbacks {
  onState(state: LiveState, detail?: string): void;
  onAudio(b64: string): void;
  onInterrupted(): void;
  onInputText(text: string): void;
  onOutputText(text: string): void;
  onTurnComplete(): void;
  onToolCall(calls: FunctionCall[]): void;
  onToolCancel(ids: string[]): void;
}

export interface LiveOptions {
  apiKey: string;
  model: string;
  voice: string;
  systemInstruction: () => string;
  declarations: FunctionDeclaration[];
}

/** Close codes that mean "your request is wrong" — retrying won't help. */
const FATAL_CODES = new Set([1007, 1008]);

/**
 * Gemini Live session with automatic, seamless reconnection:
 * session-resumption handles + context-window compression keep one logical
 * conversation alive across the server's ~10 min connection limit and goAway notices.
 */
export class LiveClient {
  private ai: GoogleGenAI;
  private session?: Session;
  private resumeHandle?: string;
  private ready = false;
  private closing = false;
  private retries = 0;

  constructor(private opts: LiveOptions, private cb: LiveCallbacks) {
    this.ai = new GoogleGenAI({ apiKey: opts.apiKey });
  }

  get isLive() {
    return this.ready;
  }

  async connect() {
    this.closing = false;
    this.ready = false;
    this.cb.onState(this.resumeHandle ? 'reconnecting' : 'connecting');
    const { model, voice, declarations, systemInstruction } = this.opts;
    try {
      this.session = await this.ai.live.connect({
        model,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
          systemInstruction: systemInstruction(),
          tools: [{ functionDeclarations: declarations }, { googleSearch: {} }],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          contextWindowCompression: { slidingWindow: {} },
          sessionResumption: { handle: this.resumeHandle },
          realtimeInputConfig: {
            automaticActivityDetection: {
              startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
              endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
              prefixPaddingMs: 120,
              silenceDurationMs: 450,
            },
          },
        },
        callbacks: {
          onmessage: (m) => this.onMessage(m),
          onerror: (e) => this.cb.onState('error', (e as ErrorEvent).message || 'Connection error'),
          onclose: (e) => this.onClose(e),
        },
      });
    } catch (e: any) {
      this.cb.onState('error', e?.message ?? String(e));
      this.scheduleReconnect();
    }
  }

  private onMessage(m: LiveServerMessage) {
    if (m.setupComplete) {
      this.ready = true;
      this.retries = 0;
      this.cb.onState('live');
    }
    const sc = m.serverContent;
    if (sc) {
      if (sc.interrupted) this.cb.onInterrupted();
      for (const p of sc.modelTurn?.parts ?? []) {
        if (p.inlineData?.data && p.inlineData.mimeType?.startsWith('audio/')) this.cb.onAudio(p.inlineData.data);
      }
      if (sc.inputTranscription?.text) this.cb.onInputText(sc.inputTranscription.text);
      if (sc.outputTranscription?.text) this.cb.onOutputText(sc.outputTranscription.text);
      if (sc.turnComplete) this.cb.onTurnComplete();
    }
    if (m.toolCall?.functionCalls?.length) this.cb.onToolCall(m.toolCall.functionCalls);
    if (m.toolCallCancellation?.ids?.length) this.cb.onToolCancel(m.toolCallCancellation.ids);
    const r = m.sessionResumptionUpdate;
    if (r?.resumable && r.newHandle) this.resumeHandle = r.newHandle;
    if (m.goAway) {
      // Server is about to drop us — hop to a fresh connection now, carrying the handle.
      this.ready = false;
      this.session?.close();
    }
  }

  private onClose(e: CloseEvent) {
    this.ready = false;
    this.session = undefined;
    if (this.closing) return this.cb.onState('closed');
    if (FATAL_CODES.has(e.code)) {
      this.resumeHandle = undefined;
      return this.cb.onState('error', e.reason || `Session rejected (code ${e.code})`);
    }
    this.scheduleReconnect(e.reason);
  }

  private scheduleReconnect(reason?: string) {
    if (this.closing) return;
    const delay = Math.min(8000, 250 * 2 ** this.retries++);
    this.cb.onState('reconnecting', reason);
    setTimeout(() => !this.closing && !this.session && this.connect(), delay);
  }

  sendAudio(b64: string) {
    if (this.ready) this.session?.sendRealtimeInput({ audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } });
  }

  endAudio() {
    if (this.ready) this.session?.sendRealtimeInput({ audioStreamEnd: true });
  }

  sendImage(b64: string, mimeType = 'image/jpeg') {
    if (this.ready) this.session?.sendRealtimeInput({ video: { data: b64, mimeType } });
  }

  sendText(text: string) {
    if (this.ready) this.session?.sendRealtimeInput({ text });
  }

  sendToolResponses(functionResponses: FunctionResponse[]) {
    if (this.session && functionResponses.length) this.session.sendToolResponse({ functionResponses });
  }

  close() {
    this.closing = true;
    this.ready = false;
    this.session?.close();
  }
}

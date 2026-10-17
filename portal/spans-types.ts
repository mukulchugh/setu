export type SpansJson =
  | null
  | boolean
  | number
  | string
  | SpansJson[]
  | { [key: string]: SpansJson };
export interface SpansRecord {
  generation: number;
  revision: number;
  runId: string;
  view: Record<string, SpansJson>;
}
export interface SpansEvent {
  eventId: string;
  payload: SpansJson;
  runId: string;
  sequence: number;
  type: string;
}
export interface SpansFailure {
  code: string;
  error: string;
  ok: false;
}
export type SpansArtifactResult =
  | SpansFailure
  | {
      artifactId: string;
      mediaType: 'text/plain' | 'application/json';
      ok: true;
      runId: string;
      text: string;
    };
export type SpansPhase = 'all' | 'past' | 'live' | 'planned';

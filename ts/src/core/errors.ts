export class VdlError extends Error {
  constructor(public code: string, message: string, public nextAction = '') {
    super(message);
    this.name = 'VdlError';
  }

  toBody() {
    return { code: this.code, message: this.message, next_action: this.nextAction };
  }
}

export function fail(platform: string, engine: string, err: unknown, nextAction = '') {
  if (err instanceof VdlError) {
    return {
      schema: 2, ok: false, platform, engine, media: null, formats: [],
      warnings: [], error: err.toBody(),
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    schema: 2, ok: false, platform, engine, media: null, formats: [],
    warnings: [],
    error: { code: 'internal', message, next_action: nextAction || '看一下原始报错' },
  };
}

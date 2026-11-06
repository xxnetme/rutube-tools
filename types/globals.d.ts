/* Общие браузерные точки сборки без подключения @types/node к рантайму. */
declare var module: { exports: any };
declare var muxjs: any;
declare var RTAudio: any;
declare var RTLib: any;
declare var RTNetwork: {
  isAllowedUrl(raw: unknown): boolean;
  isAllowedDataUrl(raw: unknown): boolean;
  assertAllowedUrl(raw: unknown): string;
  fetch(input: string, init?: RequestInit): Promise<Response>;
};

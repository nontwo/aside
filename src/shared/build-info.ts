/**
 * A non-sensitive identifier for the built bundle, injected at build time so an
 * installed candidate can be matched to a commit. In tests and unbundled runs it
 * reads as "dev".
 */
declare const __ASIDE_BUILD__: string | undefined;

export const BUILD_ID: string =
  typeof __ASIDE_BUILD__ === 'string' && __ASIDE_BUILD__ ? __ASIDE_BUILD__ : 'dev';

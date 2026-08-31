import { describe, expect, it } from 'vitest';
import { buildThemeEditorDeepLink } from './onboarding.routes.js';

describe('buildThemeEditorDeepLink', () => {
  it('targets the product template main section with the app block', () => {
    const url = buildThemeEditorDeepLink('s.myshopify.com', 'apikey123');
    expect(url).toBe(
      'https://s.myshopify.com/admin/themes/current/editor' +
        '?template=product&addAppBlockId=apikey123/tryon-button&target=mainSection',
    );
  });

  it('no longer uses the app-embed activation parameter', () => {
    expect(buildThemeEditorDeepLink('s.myshopify.com', 'k')).not.toContain('activateAppId');
  });
});

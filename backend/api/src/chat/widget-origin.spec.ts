import { allowedOriginsOf, isWidgetOriginAllowed } from './widget-origin';

describe('chat widget origin check', () => {
  const frontend = 'https://desk.example.com';

  it('allows anything when the channel lists no origins', () => {
    expect(isWidgetOriginAllowed('https://anywhere.test', frontend, [])).toBe(true);
  });

  it('always allows the product frontend and origin-less callers', () => {
    expect(isWidgetOriginAllowed('https://desk.example.com', frontend, ['shop.test'])).toBe(true);
    expect(isWidgetOriginAllowed(undefined, frontend, ['shop.test'])).toBe(true);
  });

  it('enforces the list once it has entries', () => {
    const allowed = ['https://shop.test', 'blog.test', '*.brand.test'];
    expect(isWidgetOriginAllowed('https://shop.test', frontend, allowed)).toBe(true);
    expect(isWidgetOriginAllowed('http://shop.test', frontend, allowed)).toBe(false);
    expect(isWidgetOriginAllowed('http://blog.test', frontend, allowed)).toBe(true);
    expect(isWidgetOriginAllowed('https://eu.brand.test', frontend, allowed)).toBe(true);
    expect(isWidgetOriginAllowed('https://brand.test', frontend, allowed)).toBe(false);
    expect(isWidgetOriginAllowed('https://evil.test', frontend, allowed)).toBe(false);
    expect(isWidgetOriginAllowed('https://shop.test.evil.test', frontend, allowed)).toBe(false);
    expect(isWidgetOriginAllowed('null', frontend, allowed)).toBe(false);
  });

  it('reads the list defensively from channel config', () => {
    expect(allowedOriginsOf({ allowedOrigins: ['a.test', 3, ' '] })).toEqual(['a.test']);
    expect(allowedOriginsOf(null)).toEqual([]);
  });
});

const STATIC_ASSET_PATTERN = /\.(ya?ml|json|txt|xml|pdf|zip|png|jpe?g|gif|webp|svg|ico|woff2?)$/i;
const EXTERNAL_PROTOCOL_PATTERN = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

export interface MarkdownLinkContext {
  currentPath: string;
}

function splitPathSuffix(href: string): { pathname: string; suffix: string } {
  const hashIndex = href.indexOf('#');
  const queryIndex = href.indexOf('?');
  const splitIndex =
    hashIndex === -1 ? queryIndex : queryIndex === -1 ? hashIndex : Math.min(hashIndex, queryIndex);

  if (splitIndex === -1) {
    return { pathname: href, suffix: '' };
  }

  return {
    pathname: href.slice(0, splitIndex),
    suffix: href.slice(splitIndex),
  };
}

export function isStaticAssetPathname(pathname: string): boolean {
  return STATIC_ASSET_PATTERN.test(pathname);
}

export function resolveStaticAssetHref(href: string, context: MarkdownLinkContext): string | null {
  if (!href || href === '#' || href.startsWith('#') || EXTERNAL_PROTOCOL_PATTERN.test(href)) {
    return null;
  }

  const { pathname, suffix } = splitPathSuffix(href);
  if (!isStaticAssetPathname(pathname)) {
    return null;
  }

  if (href.startsWith('/')) {
    return href;
  }

  if (!pathname.includes('/')) {
    return `/${pathname}${suffix}`;
  }

  const baseDirectory = context.currentPath.includes('/')
    ? context.currentPath.slice(0, context.currentPath.lastIndexOf('/') + 1)
    : '';
  const resolved = new URL(pathname, `https://docs.local/${baseDirectory}`);
  return `${resolved.pathname}${suffix}`;
}
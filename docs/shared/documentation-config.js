/**
 * Oblivion documentation site configuration.
 * Framework sync: git subtree pull from https://github.com/thomasjvu/papers
 */

/** @type {{ current: string, versions: string[], labels: Record<string, string>, enabled: boolean }} */
export const versionConfig = {
  current: '1.0',
  versions: ['1.0'],
  labels: {
    '1.0': 'Latest',
  },
  enabled: false,
};

/** @type {{ enabled: boolean, defaultLocale: string, locales: string[] }} */
export const i18nConfig = {
  enabled: false,
  defaultLocale: 'en',
  locales: ['en'],
};

/** @type {{ sidebarBrand: { subtitle: string | null } }} */
export const siteConfig = {
  sidebarBrand: {
    subtitle: null,
  },
};

/** @type {import('./documentation-config.js').OpenApiConfig} */
export const openapiConfig = {
  enabled: false,
  pagePath: 'developers/openapi',
  defaultSpecId: 'partner',
  specs: [
    {
      id: 'partner',
      label: 'Partner API',
      url: '/openapi-v1.yaml',
      description: 'B2B rail for embedded partners — cases, webhooks, billing.',
    },
    {
      id: 'consumer',
      label: 'Consumer API',
      url: '/openapi-consumer.yaml',
      description: 'Browser app endpoints — cases, intake, approvals, agent runs.',
    },
  ],
};

/** @type {import('./documentation-config.js').HomepageConfig} */
export const homepageConfig = {
  enabled: true,
  hero: {
    title: 'Oblivion',
    subtitle: 'Private cleanup agent',
    description:
      'Personal information removal without giving away your personal information. Encrypted in the browser. Every disclosure stops at an explicit approval gate.',
    artwork: {
      src: '/images/docs/placeholders/template-hero-banner.svg',
      alt: 'Oblivion documentation hero placeholder',
      caption: '1-bit Game Boy palette docs for the Oblivion supervised cleanup agent.',
    },
    cta: {
      primary: {
        text: 'User guide',
        href: '/docs/user-guide/overview',
      },
      secondary: {
        text: 'Open app',
        href: 'https://oblivion.phantasy.bot',
      },
    },
  },
  features: [
    {
      title: 'Browser vault',
      description: 'Raw identifiers stay client-side. The server stores ciphertext and redacted metadata only.',
      icon: 'pixelarticons:lock',
    },
    {
      title: 'Approval gates',
      description: 'Every disclosure is proposed, reviewed, and explicitly confirmed before execution.',
      icon: 'pixelarticons:check',
    },
    {
      title: 'Partner API',
      description: 'Embed the same workflow in password managers, VPNs, and security products.',
      icon: 'pixelarticons:script',
    },
    {
      title: 'Trust center',
      description: 'Hardware attestation before sensitive live sends in production.',
      icon: 'pixelarticons:debug-check',
    },
  ],
  quickStart: {
    title: 'Start in 4 steps',
    steps: [
      {
        title: 'Read the user guide',
        code: 'visit /docs/user-guide/overview',
      },
      {
        title: 'Open the app',
        code: 'https://oblivion.phantasy.bot',
      },
      {
        title: 'Pick a cleanup template',
        code: 'see /docs/user-guide/templates',
      },
      {
        title: 'Approve before send',
        code: 'nothing leaves without your confirmation',
      },
    ],
  },
  footer: {
    links: [
      { text: 'User guide', href: '/docs/user-guide/overview' },
      { text: 'Consumer API', href: '/docs/developers/consumer-api' },
      { text: 'Partner API', href: '/docs/developers/partner-api' },
      { text: 'Pricing', href: '/docs/pricing' },
      { text: 'FAQ', href: '/docs/faq' },
      { text: 'App', href: 'https://oblivion.phantasy.bot' },
      { text: 'GitHub', href: 'https://github.com/thomasjvu/oblivion' },
    ],
  },
};

/** @type {import('./documentation-config.js').FileItem[]} */
export const documentationTree = [
  {
    type: 'directory',
    name: 'User Guide',
    path: 'user-guide',
    children: [
      {
        type: 'file',
        name: 'Overview.md',
        path: 'user-guide/overview',
        tags: ['getting-started', 'guide', 'oblivion'],
      },
      {
        type: 'file',
        name: 'Templates.md',
        path: 'user-guide/templates',
        tags: ['presets', 'workflow', 'guide'],
      },
    ],
  },
  {
    type: 'file',
    name: 'Pricing.md',
    path: 'pricing',
    tags: ['pricing', 'x402', 'plans'],
  },
  {
    type: 'file',
    name: 'FAQ.md',
    path: 'faq',
    tags: ['faq', 'help', 'getting-started'],
  },
  {
    type: 'directory',
    name: 'Developers',
    path: 'developers',
    children: [
      {
        type: 'file',
        name: 'Consumer API.md',
        path: 'developers/consumer-api',
        tags: ['api', 'auth', 'consumer'],
      },
      {
        type: 'file',
        name: 'Partner API.md',
        path: 'developers/partner-api',
        tags: ['partner', 'api', 'integration'],
      },
      {
        type: 'file',
        name: 'Partner Onboarding.md',
        path: 'developers/partner-onboarding',
        tags: ['partner', 'onboarding'],
      },
      {
        type: 'file',
        name: 'API Reference.md',
        path: 'developers/api-reference',
        tags: ['openapi', 'reference'],
      },
      {
        type: 'file',
        name: 'Hackathon Demo.md',
        path: 'developers/hackathon-demo',
        tags: ['demo', 'hackathon'],
      },
      {
        type: 'file',
        name: 'Trust & Security.md',
        path: 'developers/security',
        tags: ['security', 'trust', 'tee'],
      },
    ],
  },
  {
    type: 'file',
    name: 'LLMs.txt',
    path: 'llms',
    tags: ['llms', 'ai', 'exports'],
  },
  {
    type: 'directory',
    name: 'Legal',
    path: 'legal',
    children: [
      {
        type: 'file',
        name: 'Privacy.md',
        path: 'legal/privacy',
        tags: ['legal', 'privacy'],
      },
      {
        type: 'file',
        name: 'Terms.md',
        path: 'legal/terms',
        tags: ['legal', 'terms'],
      },
    ],
  },
];
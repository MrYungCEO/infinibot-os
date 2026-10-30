// Trimmed real plugins.list shapes (src/gateway/server-methods/plugins.ts summarize()).
export const PLUGINS = {
  plugins: [
    {
      id: 'infinitrade', name: 'Infinitrade', enabled: true, status: 'loaded', manifestVersion: 2,
      appearance: { monogram: 'IT', icon: 'chart', themes: { dark: { vars: { '--plugin-accent': '#22c55e' } } } },
      contributes: {
        nav: [{ tab: 'infinitrade', label: 'Infinitrade', icon: 'chart' }],
        pages: [
          { tab: 'infinitrade', route: '/infinitrade', builtin: 'infinitrade', title: 'Trader OS' },
          { tab: 'infinitrade-signals', route: '/infinitrade/signals', builtin: 'infinitrade-signals', title: 'Signals' },
          { tab: 'infinitrade-journal', route: '/infinitrade/journal', builtin: 'infinitrade-journal', title: 'Journal' },
        ],
        navSection: {
          title: 'Infinitrade', order: 75,
          items: [
            { page: 'infinitrade', label: 'Dashboard', icon: 'chart' },
            { page: 'infinitrade-signals', label: 'Signals', icon: 'radar' },
            { page: 'infinitrade-journal', label: 'Journal', icon: 'book' },
          ],
        },
      },
      disabledContributions: ['page:infinitrade-journal'],
    },
    {
      id: 'discipline', name: 'Discipline', enabled: true, status: 'loaded', manifestVersion: 2,
      appearance: { monogram: 'DS', icon: 'target' },
      contributes: {
        nav: [{ tab: 'discipline', label: 'Discipline', icon: 'target' }],
        pages: [
          { tab: 'discipline', route: '/discipline', builtin: 'discipline', title: 'Day planner' },
          { tab: 'focus', route: '/focus', builtin: 'focus', title: 'Focus board' },
        ],
        navSection: { title: 'Discipline', items: [{ page: 'discipline', label: 'Day', icon: 'target' }, { page: 'focus', label: 'Focus board', icon: 'star' }] },
      },
    },
    {
      id: 'solatrix', name: 'Solatrix', enabled: false, status: 'disabled', manifestVersion: 2,
      contributes: { nav: [], pages: [{ tab: 'solatrix-alerts', route: '/solatrix/alerts', builtin: 'solatrix-alerts' }, { tab: 'solatrix', route: '/solatrix', builtin: 'solatrix-terminal' }] },
    },
    {
      id: 'business-agency', name: 'Business & Agency', enabled: true, status: 'loaded', manifestVersion: 2,
      contributes: {
        nav: [],
        pages: [
          { tab: 'opportunities', route: '/opportunities', builtin: 'opportunities', title: 'Opportunities' },
          { tab: 'agency-daily', route: '/agency-daily', builtin: 'agency-daily', title: 'Agency Daily' },
        ],
        navSection: { title: 'Business & Agency', order: 10 },
      },
    },
    { id: 'legacy-v1', name: 'Old', enabled: true, status: 'loaded', manifestVersion: 1, ui: { navLabel: 'Old', entry: '/x' } },
  ],
};

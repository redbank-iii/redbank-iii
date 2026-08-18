// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  // Served from the apex domain root — keep in sync with public/CNAME.
  site: 'https://redbank-iii.org',
  base: '/',
  output: 'static',
  i18n: {
    defaultLocale: 'zh',
    locales: ['zh', 'en', 'fr'],
    routing: {
      prefixDefaultLocale: true,
    },
  },
});

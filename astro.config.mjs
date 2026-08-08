// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://redbank-iii.github.io',
  base: '/redbank-iii',
  output: 'static',
  i18n: {
    defaultLocale: 'zh',
    locales: ['zh', 'en', 'fr'],
    routing: {
      prefixDefaultLocale: true,
    },
  },
});

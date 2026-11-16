import { defineConfig } from "astro/config";

import { resolveReleaseRepository } from "./src/lib/releaseRepository.ts";

const releaseRepository = resolveReleaseRepository(process.env.F5_RELEASE_REPOSITORY);

export default defineConfig({
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
  vite: {
    define: {
      __F5_RELEASE_REPOSITORY__: JSON.stringify(releaseRepository),
    },
  },
});

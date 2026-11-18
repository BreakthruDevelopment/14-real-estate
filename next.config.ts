import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // One self-contained server bundle, so the same Docker image runs on every cloud.
  output: "standalone",
  // Cache Components stays off in the template: most apps here read the session on
  // nearly every page, and the classic dynamic model keeps that simple. An app can
  // opt in later if it has mostly public, cacheable pages.
  cacheComponents: false,
  // Loaded at runtime, never bundled: the Postgres driver, and sharp, whose native binding is chosen per
  // platform (`@img/sharp-linuxmusl-x64` in the Alpine runner). Bundling either one breaks that choice.
  serverExternalPackages: ["postgres", "sharp"],
  // The upload route (14.4) loads the image module only through a dynamic import, which file tracing can miss,
  // and the runner image would then ship without sharp. Naming it here puts it in the trace whatever the routes
  // happen to import, which is what the CI step that loads sharp inside the built Alpine image checks.
  outputFileTracingIncludes: {
    "/*": ["./node_modules/sharp/**/*", "./node_modules/@img/sharp-linuxmusl-*/**/*", "./node_modules/@img/sharp-libvips-linuxmusl-*/**/*", "./node_modules/@img/sharp-linux-*/**/*", "./node_modules/@img/sharp-libvips-linux-*/**/*"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;

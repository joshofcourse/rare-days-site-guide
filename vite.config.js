import { defineConfig } from "vite";

// Relative asset paths, so the built site works from a sub-folder such as
// GitHub Pages (https://<user>.github.io/<repo>/).
export default defineConfig({ base: "./" });

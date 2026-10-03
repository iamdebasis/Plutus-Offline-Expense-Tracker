// Lets Node run the app's TypeScript as it is (Node strips the types): the app's imports leave out ".ts", the
// way the bundler allows, so this finds the file they mean. Used by `pnpm test`; nothing here ships.
import { register } from 'node:module'

register('./resolve.mjs', import.meta.url)

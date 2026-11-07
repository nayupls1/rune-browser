{
  "name": "{{slug}}",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --hot src/server.ts",
    "build": "bun build --target=bun --production --outdir=dist src/server.ts",
    "start": "bun dist/server.js"
  },
  "devDependencies": {
    "@types/bun": "latest"
  }
}

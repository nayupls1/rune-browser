{
  "name": "{{slug}}",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --hot src/server.ts",
    "build": "bun build --target=bun --production --public-path=/ --outdir=dist src/server.ts",
    "start": "cd dist && bun server.js"
  },
  "devDependencies": {
    "@types/bun": "latest"
  }
}

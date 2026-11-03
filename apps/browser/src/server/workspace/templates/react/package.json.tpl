{
  "name": "{{slug}}",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --hot src/server.ts",
    "build": "bun build --target=bun --production --public-path=/ --outdir=dist src/server.ts",
    "start": "cd dist && bun server.js"
  },
  "dependencies": {
    "react": "^19.2.0",
    "react-dom": "^19.2.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0"
  }
}

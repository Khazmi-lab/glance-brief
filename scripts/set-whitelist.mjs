// Usage: node scripts/set-whitelist.mjs https://your-backend.example.com
// Writes the backend origin into app.json's network permission whitelist (Even Hub
// requires every external origin to be listed) before `npm run pack`.
import { readFileSync, writeFileSync } from 'node:fs'
const origin = process.argv[2]
if (!origin || !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin.replace(/\/+$/, '')) && !/^http:\/\/localhost(:\d+)?$/.test(origin)) {
  console.error('usage: set-whitelist.mjs https://backend.example.com (https origin, no path)')
  process.exit(2)
}
const app = JSON.parse(readFileSync('app.json', 'utf8'))
const net = app.permissions.find(p => p.name === 'network')
net.whitelist = [origin.replace(/\/+$/, '')]
writeFileSync('app.json', JSON.stringify(app, null, 2) + '\n')
console.log('network whitelist ->', net.whitelist)

import fs from 'node:fs'

const version = process.argv[2] || new Date().toISOString().slice(0, 10).replaceAll('-', '.')
const match = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(version)

if (!match) {
  throw new Error(`Invalid version "${version}": expected YYYY.MM.DD`)
}

const [, year, month, day] = match
const date = new Date(`${year}-${month}-${day}T00:00:00.000Z`)

if (
  date.getUTCFullYear() !== Number(year) ||
  date.getUTCMonth() + 1 !== Number(month) ||
  date.getUTCDate() !== Number(day)
) {
  throw new Error(`Invalid calendar date "${version}"`)
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'))
}

function writeJson(path, value) {
  fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

const packageJson = readJson('package.json')
packageJson.version = version
writeJson('package.json', packageJson)

const metadataPath = 'unite@hardpixel.eu/metadata.json'
const metadata = readJson(metadataPath)

// GNOME requires this field to be an integer, so use the sortable date while
// exposing the dotted calendar version through its version-name field.
metadata.version = Number(`${year}${month}${day}`)
metadata['version-name'] = version
writeJson(metadataPath, metadata)

console.log(version)

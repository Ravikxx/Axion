import os from 'os';
import { join } from 'path';

const home = os.homedir();

const DARWIN_HOME = [
  'Music', 'Pictures', 'Movies', 'Downloads',
  'Desktop', 'Documents', 'Public', 'Applications', 'Library',
];

const DARWIN_LIBRARY = [
  'Application Support/AddressBook',
  'Calendars',
  'Mail',
  'Messages',
  'Safari',
  'Cookies',
  'Application Support/com.apple.TCC',
  'PersonalizationPortrait',
  'Metadata/CoreSpotlight',
  'Suggestions',
];

const DARWIN_ROOT = ['/.DocumentRevisions-V100', '/.Spotlight-V100', '/.Trashes', '/.fseventsd'];
const WIN32_HOME = ['AppData', 'Downloads', 'Desktop', 'Documents', 'Pictures', 'Music', 'Videos', 'OneDrive'];

/**
 * Absolute paths that should never be watched, stated, or scanned.
 * @returns {string[]}
 */
export function protectedPaths() {
  if (process.platform === 'darwin')
    return [
      ...DARWIN_HOME.map(name => join(home, name)),
      ...DARWIN_LIBRARY.map(name => join(home, 'Library', name)),
      ...DARWIN_ROOT,
    ];
  if (process.platform === 'win32')
    return WIN32_HOME.map(name => join(home, name));
  return [];
}

/**
 * Filter protected paths that fall within a given directory.
 * @param {string} dir
 * @returns {string[]}
 */
export function filterProtected(dir) {
  return protectedPaths().filter(p => p.startsWith(dir) && p !== dir);
}

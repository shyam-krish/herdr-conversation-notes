// An exclusive flock(2) held by a small helper process, compatible with the TUI
// plugin's fcntl.flock on the same files. The app's script runtime can't hold a
// file descriptor, so `lockf` (macOS) or `flock` (Linux) holds the lock while a
// helper waits on a private named pipe next to the lock file. Writing to the pipe
// releases the lock at once; the helper also lets go by itself after `maxSeconds`
// (renewed by the caller), so a crashed app can't keep a note locked for long.
// `ended` resolves when the helper has exited, which is when the lock is free.

const BUSY_CODES = { lockf: 75, flock: 1 };

// Blocks without spawning anything: read -t returns at once on the release
// newline, and every 5 s (builtins only) to give up if the pipe was deleted or the
// time limit passed.
const HOLD_BASH = [
  'mkfifo -m 600 "$1" || exit 70',
  'exec 3<>"$1"',
  "i=0",
  'while [ -p "$1" ] && [ "$i" -lt "$2" ]; do',
  "  read -r -t 5 -u 3 _ && break",
  "  i=$((i+5))",
  "done",
  'rm -f "$1"',
].join("\n");

// Without bash: poll for the pipe's removal (release removes it).
const HOLD_SH = [
  'mkfifo -m 600 "$1" || exit 70',
  "i=0",
  'while [ -p "$1" ] && [ "$i" -lt $(($2 * 5)) ]; do sleep 0.2; i=$((i+1)); done',
  'rm -f "$1"',
].join("\n");

const RELEASE = '[ -p "$1" ] && printf "\\n" > "$1"; rm -f "$1"; exit 0';

let tools = null;

async function detect(sys) {
  if (!tools) {
    tools = {
      lock: (await sys.exists("/usr/bin/lockf")) ? "lockf" : "flock",
      bash: await sys.exists("/bin/bash"),
    };
  }
  return tools;
}

export async function holdLock(sys, path, { waitSeconds = 0, maxSeconds = 580 } = {}) {
  const marker = `${path}.gui-${sys.uuid()}`;
  const { lock, bash } = await detect(sys);
  const command = bash
    ? ["/bin/bash", "-c", HOLD_BASH, "hold", marker, String(maxSeconds)]
    : ["/bin/sh", "-c", HOLD_SH, "hold", marker, String(maxSeconds)];
  // -k keeps the lock file, as Python's flock users do: deleting it would let a
  // waiter lock the old inode while a newcomer locks a new file of the same name.
  const argv = lock === "lockf"
    ? ["/usr/bin/lockf", "-k", "-s", "-t", String(waitSeconds), path, ...command]
    : ["flock", ...(waitSeconds ? ["-w", String(waitSeconds)] : ["-n"]), path, ...command];
  const ended = sys.exec(argv[0], argv.slice(1), { timeout: (maxSeconds + waitSeconds + 30) * 1000 })
    .then((result) => result, (error) => ({ code: -1, stdout: "", stderr: String(error) }));
  const watch = 'i=0; while [ ! -e "$1" ] && [ "$i" -lt "$2" ]; do sleep 0.05; i=$((i+1)); done; [ -e "$1" ]';
  const acquired = sys.exec("/bin/sh", ["-c", watch, "sh", marker, String((waitSeconds + 2) * 20)],
    { timeout: (waitSeconds + 15) * 1000 }).then((result) => result.code === 0, () => false);
  const first = await Promise.race([ended.then(() => "ended"), acquired.then((ok) => (ok ? "acquired" : "timeout"))]);
  const release = async () => {
    try {
      await sys.exec("/bin/sh", ["-c", RELEASE, "sh", marker], { timeout: 5000 });
    } catch {}
  };
  if (first !== "acquired") {
    const result = await Promise.race([ended, acquired.then(() => null)]);
    await release();
    if (result && result.code !== BUSY_CODES[lock] && result.code !== 0) {
      // No lock helper here at all: keep notes usable, like an unlocked editor.
      return { ended: new Promise(() => {}), release: async () => {}, unlocked: true };
    }
    return null;
  }
  let released = null;
  return {
    ended,
    release() {
      // Resolves once the helper has exited, so the lock is free for the next opener.
      if (!released) released = release().then(() => Promise.race([ended, sys.exec("/bin/sleep", ["2"]).catch(() => {})]));
      return released;
    },
  };
}

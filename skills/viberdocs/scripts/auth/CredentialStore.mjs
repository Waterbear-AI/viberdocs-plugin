import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export class CredentialStore {
  constructor(root) {
    this.root = path.resolve(root);
    this.base = path.join(this.root, '.viberdocs');
    this.state = path.join(this.base, 'state');
  }

  async directory(dir) {
    try {
      await fs.mkdir(dir, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const st = await fs.lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077)) {
      throw new Error('unsafe_state');
    }
  }

  async init() {
    if (!['darwin', 'linux'].includes(process.platform) || ![22, 24].includes(Number(process.versions.node.split('.')[0]))) {
      throw new Error('unsupported_host');
    }
    const root = await fs.realpath(this.root);
    if (root !== this.root) throw new Error('unsafe_state');
    await this.directory(this.base);
    const ignore = path.join(this.base, '.gitignore');
    const ignoreTemp = path.join(this.base, `.ignore-${randomUUID()}`);
    try {
      const fd = await fs.open(ignoreTemp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await fd.writeFile('*\n!.gitignore\n');
        await fd.sync();
      } finally {
        await fd.close();
      }
      await fs.link(ignoreTemp, ignore);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    } finally {
      await fs.unlink(ignoreTemp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    const ignoreStat = await fs.lstat(ignore);
    if (!ignoreStat.isFile() || ignoreStat.isSymbolicLink() || ignoreStat.uid !== process.getuid() ||
        (ignoreStat.mode & 0o077) || await fs.readFile(ignore, 'utf8') !== '*\n!.gitignore\n') {
      throw new Error('unsafe_state');
    }
    await this.directory(this.state);
    try {
      const tracked = execFileSync('git', ['ls-files', '--', '.viberdocs/state'], {
        cwd: this.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (tracked.trim()) throw new Error('tracked_state');
    } catch (error) {
      const notRepository = error.status === 128 && /^fatal: not a git repository\b/.test(error.stderr || '');
      if (!notRepository) throw error;
    }
  }

  file(name) {
    if (!/^(?:operations\/)?[a-z0-9-]+\.json$/.test(name)) throw new Error('unsafe_state');
    return path.join(this.state, name);
  }

  async read(name) {
    const file = this.file(name);
    let fd;
    try {
      fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const st = await fd.stat();
      if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) || st.size > 65536) {
        throw new Error('unsafe_state');
      }
      return JSON.parse(await fd.readFile('utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    } finally {
      if (fd) await fd.close();
    }
  }

  async write(name, data) {
    const dest = this.file(name);
    try {
      const st = await fs.lstat(dest);
      if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077)) {
        throw new Error('unsafe_state');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const targetDirectory = path.dirname(dest);
    const tmp = path.join(targetDirectory, `.tmp-${randomUUID()}`);
    let fd;
    try {
      fd = await fs.open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await fd.writeFile(JSON.stringify(data));
      await fd.sync();
      await fd.close();
      fd = null;
      await fs.rename(tmp, dest);
      const dir = await fs.open(targetDirectory, constants.O_RDONLY);
      try { await dir.sync(); } finally { await dir.close(); }
    } finally {
      if (fd) await fd.close();
      await fs.unlink(tmp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async remove(name) {
    await fs.unlink(this.file(name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }

  async withLock(fn) {
    await this.init();
    const directory = path.join(this.state, 'auth-locks');
    await this.directory(directory);
    const id = randomUUID();
    const own = path.join(directory, id);
    const deadline = Date.now() + 30000;
    const publish = async value => {
      const temporary = path.join(directory, `.tmp-${randomUUID()}`);
      try {
        const fd = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await fd.writeFile(JSON.stringify(value)); await fd.sync(); } finally { await fd.close(); }
        if (value.phase === 'choosing') await fs.link(temporary, own);
        else await fs.rename(temporary, own);
      } finally {
        await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    };
    const contenders = async () => {
      const names = (await fs.readdir(directory)).filter(name => /^[0-9a-f-]{36}$/.test(name));
      if (names.length > 1024) throw new Error('unsafe_state');
      const entries = [];
      for (const name of names) {
        if (name === id) continue;
        const file = path.join(directory, name);
        let fd;
        try {
          fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
          const st = await fd.stat();
          if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) || st.size > 256) throw new Error('unsafe_state');
          const record = JSON.parse(await fd.readFile('utf8'));
          if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || !['choosing', 'waiting'].includes(record.phase) ||
              (record.phase === 'waiting' && (!Number.isSafeInteger(record.ticket) || record.ticket < 1))) throw new Error('unsafe_state');
          let dead = false;
          try { process.kill(record.pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
          if (dead) {
            await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
          } else {
            entries.push({ id: name, ...record });
          }
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        } finally {
          if (fd) await fd.close();
        }
      }
      return entries;
    };
    await publish({ pid: process.pid, phase: 'choosing' });
    try {
      const initial = await contenders();
      const ticket = Math.max(0, ...initial.filter(entry => entry.phase === 'waiting').map(entry => entry.ticket)) + 1;
      if (!Number.isSafeInteger(ticket)) throw new Error('unsafe_state');
      await publish({ pid: process.pid, phase: 'waiting', ticket });
      while (true) {
        const others = await contenders();
        if (!others.some(entry => entry.phase === 'choosing' || entry.ticket < ticket ||
            (entry.ticket === ticket && entry.id < id))) break;
        if (Date.now() >= deadline) throw new Error('lock_timeout');
        await pause(100);
      }
      return await fn();
    } finally {
      await fs.unlink(own).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}

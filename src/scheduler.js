const TZ_OFFSET_MINUTES = 7 * 60;

export function normalizeRecipient(value) {
  let number = String(value || '').trim().replace(/[\s()-]/g, '');
  if (number.startsWith('+')) number = number.slice(1);
  if (number.startsWith('0')) number = `62${number.slice(1)}`;
  if (!/^62\d{8,14}$/.test(number)) throw new Error('Nomor tujuan harus format internasional, contoh 628123456789.');
  return number;
}

function zonedDate(date, time) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) || !Number.isInteger(hour) || !Number.isInteger(minute)
    || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) throw new Error('Tanggal atau jam tidak valid.');
  const result = new Date(Date.UTC(year, month - 1, day, hour, minute) - TZ_OFFSET_MINUTES * 60000);
  const check = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(result).replace(',', '');
  if (check !== `${date} ${time}`) throw new Error('Tanggal atau jam tidak valid.');
  return result;
}

export function parseScheduleCommand(text, now = new Date()) {
  const source = String(text || '').trim();
  if (!/^\/jadwal(?:\s|$)/i.test(source)) return null;
  const rest = source.replace(/^\/jadwal\s*/i, '').trim();
  if (!rest || /^(bantuan|help)$/i.test(rest)) return { kind: 'help' };
  if (/^daftar$/i.test(rest)) return { kind: 'list' };
  const cancel = rest.match(/^batal\s+([0-9a-f-]{36})$/i);
  if (cancel) return { kind: 'cancel', id: cancel[1] };
  const create = rest.match(/^(?:buat\s+)?(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})\s+(\+?[\d\s()-]+)\s+([\s\S]+)$/i);
  if (!create) throw new Error('Format: /jadwal YYYY-MM-DD HH:mm 628123456789 Pesan yang dikirim.');
  const scheduledAt = zonedDate(create[1], create[2]);
  if (scheduledAt.getTime() <= now.getTime()) throw new Error('Jadwal harus berada di masa depan.');
  const message = create[4].trim();
  if (message.length < 1 || message.length > 1000) throw new Error('Pesan jadwal harus 1–1000 karakter.');
  return { kind: 'create', scheduledAt: scheduledAt.toISOString(), recipientNumber: normalizeRecipient(create[3]), message };
}

export function scheduleHelp() {
  return '🗓️ Jadwal pesan\n\n/jadwal 2026-09-20 08:30 628123456789 Pesan yang dikirim\n/jadwal daftar\n/jadwal batal ID_JADWAL\n\nWaktu menggunakan WIB (Asia/Jakarta). Nomor harus format internasional, misalnya 628123456789.';
}

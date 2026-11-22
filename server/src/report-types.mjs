// Report types (cadences). Each one changes the content: period, how trends are bucketed, what is compared, the focus,
// and a default structure. A client can replace the structure for any type; Ad-hoc follows the request.
const S = lines => lines.join('\n');

export const REPORT_TYPES = [
  { id: 'adhoc', label: 'Ad-hoc report', short: 'Ad-hoc', period: 'as requested', trend: 'whatever fits the question', compare: 'only if the request asks for it', maxSlides: 0,
    focus: 'Answer the specific request: purpose, the findings that matter for it, analysis, implications and recommendations. Structure follows the question, not a routine template.',
    structure: '' },
  { id: 'daily', label: 'Daily report', short: 'Daily', period: '1 day', trend: 'hour of the day when times are available, otherwise by outlet or platform', derive: 'date', compare: 'yesterday',
    focus: 'Speed and early warning: what happened today, what is escalating, what needs a quick response. Short and scannable.',
    maxSlides: 8, structure: S(['Cover — tanggal, sumber data', 'Ringkasan Hari Ini — tiga poin terpenting, sintesis', 'Volume & Sentimen — dibanding kemarin', 'Isu Teratas — 5 isu dengan sentimennya', 'Berita Kunci — sampel positif dan negatif dengan tautan', 'Early Warning — isu berpotensi krisis dan respons cepat yang disarankan', 'Pantauan Besok — agenda dan isu yang perlu diawasi', 'Maks 8 slide']) },
  { id: 'weekly', label: 'Weekly report', short: 'Weekly', period: '7 days', trend: 'day', derive: 'date', compare: 'the previous week',
    focus: 'Patterns of the week: trend and its triggers, media and spokespersons, sentiment and issues, risks, and recommendations for next week.',
    maxSlides: 15, structure: S(['Cover — logo klien, periode, sumber data', 'Executive Summary — sintesis seluruh slide, tidak mengulang angka slide lain', 'Tren Ekspos — tren harian per sentimen, puncak diberi anotasi peristiwa pemicunya', 'Media Distribution — Top 10 media per platform (online, cetak, TV; TV tetap tampil meski 0)', 'Top 10 Spokesperson — dengan jabatan', 'Sentimen — proporsi sentimen, top 5 isu positif dan top 5 isu negatif', 'Isu Sektor — 5 isu teratas per sektor/program prioritas klien', 'Program & Platform — pemberitaan per program/platform klien', 'Sorotan Pimpinan — pemberitaan tentang pimpinan klien', 'Wordcloud — screenshot dashboard dengan analisa', 'Sebaran Lokasi — analisa yang dikaitkan ke kegiatan klien di daerah', 'Sampel Berita Positif — 4 berita dengan tautan', 'Sampel Berita Negatif — 4 berita dengan tautan', 'Risk Mapping — potensi krisis, pemicu, tingkat risiko, langkah', 'Potensi Positif & Rekomendasi — rekomendasi komunikasi dan pantauan pekan depan', 'Maks 15 slide']) },
  { id: 'biweekly', label: 'Bi-weekly report', short: 'Bi-weekly', period: '14 days', trend: 'day, with the two weeks compared', derive: 'week', compare: 'week 1 versus week 2',
    focus: 'What shifted between the two weeks: issues that rose or faded, sentiment movement, and what to adjust.',
    maxSlides: 15, structure: S(['Cover', 'Executive Summary — sintesis dua pekan', 'Tren Ekspos — harian, pekan 1 vs pekan 2', 'Pergeseran Isu — isu yang naik dan turun', 'Media Distribution', 'Top Spokesperson', 'Sentimen — per pekan', 'Isu Sektor / Program', 'Sampel Berita Positif', 'Sampel Berita Negatif', 'Risk Mapping', 'Rekomendasi — untuk dua pekan berikutnya', 'Maks 15 slide']) },
  { id: 'monthly', label: 'Monthly report', short: 'Monthly', period: '1 month', trend: 'week', derive: 'week', compare: 'the previous month',
    focus: 'Performance of the month: trends by week, programs and campaigns, reputation of leaders, lessons, and strategy for next month.',
    maxSlides: 18, structure: S(['Cover', 'Executive Summary — sintesis bulan ini', 'Tren Bulanan — per minggu, dibanding bulan lalu bila datanya ada', 'Media Distribution', 'Top Spokesperson', 'Sentimen & Isu — top isu positif dan negatif', 'Isu Sektor / Program Prioritas', 'Kinerja Program & Kampanye', 'Sorotan Pimpinan', 'Sebaran Lokasi', 'Sampel Berita', 'Risk Mapping & Pelajaran', 'Rekomendasi Strategi Bulan Depan', 'Maks 18 slide']) },
  { id: 'bimonthly', label: 'Bi-monthly report', short: 'Bi-monthly', period: '2 months', trend: 'week, with the two months compared', derive: 'year_month', compare: 'month 1 versus month 2',
    focus: 'Medium-term movement across two months: what grew, what faded, and how the strategy should adapt.',
    maxSlides: 18, structure: S(['Cover', 'Executive Summary', 'Tren Dua Bulan — per minggu, bulan 1 vs bulan 2', 'Pergeseran Isu', 'Media Distribution', 'Top Spokesperson', 'Sentimen — per bulan', 'Isu Sektor / Program', 'Sorotan Pimpinan', 'Sampel Berita', 'Risk Mapping', 'Rekomendasi Strategi', 'Maks 18 slide']) },
  { id: 'quarterly', label: 'Quarterly report', short: 'Quarterly', period: '3 months', trend: 'month', derive: 'year_month', compare: 'the previous quarter',
    focus: 'Strategic view of the quarter: achievements against communication KPIs, strategic issues, reputation, risks, and priorities for next quarter.',
    maxSlides: 20, structure: S(['Cover', 'Executive Summary — sintesis kuartal', 'Capaian & KPI Komunikasi', 'Tren Kuartal — per bulan, dibanding kuartal lalu bila datanya ada', 'Isu Strategis Kuartal', 'Sentimen — per bulan', 'Media & Spokesperson', 'Program Prioritas', 'Reputasi Pimpinan', 'Peristiwa Kunci & Krisis', 'Risk Mapping', 'Prioritas & Rekomendasi Kuartal Depan', 'Maks 20 slide']) },
  { id: 'semester', label: 'Semester report', short: 'Semesterly', period: '6 months', trend: 'month', derive: 'year_month', compare: 'the previous semester',
    focus: 'Evaluation of six months: milestones, what worked and what did not, reputation trajectory, and the plan for the next semester.',
    maxSlides: 22, structure: S(['Cover', 'Executive Summary — sintesis semester', 'Tonggak Semester — peristiwa dan capaian utama', 'Tren per Bulan', 'Capaian & KPI', 'Isu Strategis', 'Sentimen & Reputasi', 'Media & Spokesperson', 'Program Prioritas', 'Krisis & Pelajaran', 'Risk Mapping', 'Rencana Semester Berikutnya', 'Maks 22 slide']) },
  { id: 'yearly', label: 'Yearly report', short: 'Yearly', period: '1 year', trend: 'month or quarter', derive: 'quarter', compare: 'the previous year',
    focus: 'The year in review: highlights, milestones, how reputation and issues evolved, achievements, and strategy for next year.',
    maxSlides: 25, structure: S(['Cover', 'Executive Summary — sintesis tahun ini', 'Highlights Tahun Ini', 'Tren per Bulan / Kuartal', 'Tonggak & Peristiwa Besar', 'Capaian & KPI Komunikasi', 'Isu Strategis Sepanjang Tahun', 'Sentimen & Reputasi', 'Reputasi Pimpinan', 'Media & Spokesperson', 'Program Prioritas', 'Krisis & Pelajaran', 'Strategi & Rekomendasi Tahun Depan', 'Maks 25 slide']) },
];
export const reportType = id => REPORT_TYPES.find(t => t.id === id) || null;
export function typeNote(t, period) {
  if (!t) return '';
  return `Report type: ${t.label}${period ? ` — period ${period}` : ` (${t.period})`}. Focus: ${t.focus} Trends: bucket by ${t.trend}. Comparison: ${t.compare}${t.id !== 'adhoc' ? ' — only when the data covers that earlier period; otherwise say plainly that no comparison is possible' : ''}.`;
}

// Channels: media massa (news), media sosial (posts), or both. The channel changes the vocabulary and the slides.
export const CHANNELS = [
  { id: 'medmas', label: 'Media massa', note: 'Channel: mass media (online news, print, TV). Sources are articles by outlets; speak of "berita", "media", "spokesperson".' },
  { id: 'medsos', label: 'Media sosial', note: 'Channel: social media (X, Instagram, TikTok, Facebook, YouTube…). Sources are posts by accounts; speak of "post", "akun", "platform", "engagement", "KOL", "warganet". News-sample slides become post samples (account, platform, date, link). Look at engagement, top accounts and account categories, viral content, hashtags and complaints about services.' },
  { id: 'both', label: 'Medmas + medsos', note: 'Channel: both mass media and social media. Compare how an issue plays in the news versus on social media; keep the two sources apart in charts and tables.' },
];
const MEDSOS_SWAP = [[/Media Distribution[^\n]*/g, 'Platform Distribution — sebaran post per platform dan sentimennya'], [/Top (?:10 )?Spokesperson[^\n]*/g, 'Top Akun & KOL — akun paling berpengaruh dan kategorinya (resmi, media, tokoh/KOL, publik)'],
  [/Sampel Berita Positif[^\n]*/g, 'Sampel Post Positif — 4 post dengan tautan'], [/Sampel Berita Negatif[^\n]*/g, 'Sampel Post Negatif — 4 post dengan tautan'], [/Sampel Berita[^\n]*/g, 'Sampel Post — post positif dan negatif dengan tautan'],
  [/Berita Kunci[^\n]*/g, 'Post Kunci — post positif dan negatif dengan tautan'], [/Tren Ekspos[^\n]*/g, 'Tren Percakapan — volume post per hari per sentimen, puncak diberi anotasi pemicunya'], [/Wordcloud[^\n]*/g, 'Wordcloud & Hashtag — kata dan hashtag teratas dengan analisa']];
// A structure written for news, rewritten for social media (and extended for "both").
export function adaptStructure(text, channel) {
  if (!text || channel === 'medmas' || !channel) return text;
  if (channel === 'medsos') { let t = text; for (const [re, to] of MEDSOS_SWAP) t = t.replace(re, to); if (!/Engagement|Konten Viral/i.test(t)) t = t.replace(/(\n[^\n]*(?:Sentimen)[^\n]*)/, `$1\nKonten Viral & Engagement — post dengan engagement tertinggi dan pemicunya`); if (!/Keluhan/i.test(t)) t = t.replace(/(\nRisk Mapping[^\n]*)/, `\nKeluhan Warganet — keluhan layanan yang perlu direspons$1`); return t; }
  return text.replace(/(\nMedia Distribution[^\n]*)/, `$1\nMedmas vs Medsos — bagaimana isu yang sama dibahas di berita dan di media sosial`);
}
export const channelOf = id => CHANNELS.find(c => c.id === id) || CHANNELS[0];

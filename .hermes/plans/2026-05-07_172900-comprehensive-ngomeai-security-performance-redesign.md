# Comprehensive NgomeAI Security & Performance Redesign

**Goal:** Rancang solusi komprehensif untuk mengatasi temuan keamanan kritis, isu performa, dan implementasi fitur inovasi berdasarkan laporan tim Hacker, Dokter, dan Ide.

**Date:** 7 Mei 2026, 17:29
**Priority:** CRITICAL (Security) + HIGH (Performance) + MEDIUM (Innovation)
**Context:** 
- 6 temuan keamanan (4 Kritis, 2 Tinggi) dari Tim Hacker
- 5 temuan performa (1 Kritis, 2 Tinggi, 2 Medium) dari Tim Dokter
- 1 ide fitur inovasi (Smart UX Adaptive) dari Tim Ide

---

## Proposed Approach

Tiga fase eksekusi paralel:
1. **Phase 1: Security Hardening (CRITICAL - Segera)** - Fix semua celah keamanan kritis
2. **Phase 2: Performance Optimization (HIGH - 2-3 hari)** - Optimasi performa berdasarkan audit Tim Dokter
3. **Phase 3: Innovation Implementation (MEDIUM - 1 minggu)** - Implementasi Smart UX Adaptive

---

## Step-by-Step Plan

### Phase 1: Security Hardening (CRITICAL)

**Target:** 24 jam - Segera setelah plan disetujui

#### 1.1 Fix Default Empty Secrets (CRITICAL)
**Files:** `src/config.js`

**Problem:**
- Line 42: `adminPassword` default empty string
- Line 43: `adminJwtSecret` default empty string
- Line 53: `GOWA_WEBHOOK_SECRET` default empty string

**Solution:**
```javascript
// BEFORE (DANGEROUS)
adminPassword: process.env.ADMIN_PASSWORD || '',
adminJwtSecret: process.env.ADMIN_JWT_SECRET || '',
gowebhookSecret: process.env.GOWA_WEBHOOK_SECRET || '',

// AFTER (SECURE)
adminPassword: process.env.ADMIN_PASSWORD,
adminJwtSecret: process.env.ADMIN_JWT_SECRET,
gowebhookSecret: process.env.GOWA_WEBHOOK_SECRET,

// TAMBAH validasi startup
if (!process.env.ADMIN_PASSWORD || !process.env.ADMIN_JWT_SECRET) {
  console.error('FATAL: ADMIN_PASSWORD and ADMIN_JWT_SECRET must be set in production!');
  if (process.env.NODE_ENV === 'production') {
    process.exit(1);
  }
}
```

**Verification:** 
- `grep -r "process.env.ADMIN" src/` harus tidak ada `|| ''`
- Start app tanpa env var → harus exit di production

---

#### 1.2 Remove Hardcoded Telegram Credentials (CRITICAL)
**Files:** `src/api/admin.js` lines 517-518

**Problem:**
```javascript
const botToken = process.env.TELEGRAM_BOT_TOKEN || '8671241755:AAEaN_29XipQ51sK_YKjdNLdxnyoJFYP43M';
const chatId = process.env.TELEGRAM_CHAT_ID || '1792051357';
```

**Solution:**
```javascript
// AFTER (SECURE)
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!botToken || !chatId) {
  console.warn('Telegram notifications disabled: TELEGRAM_BOT_TOKEN and/or TELEGRAM_CHAT_ID not set');
}
```

**Verification:**
- `grep -n "8671241755" src/` harus tidak ada hasil
- `grep -n "1792051357" src/` harus tidak ada hasil

---

#### 1.3 Fix Webhook Signature Verification (HIGH)
**Files:** `src/api/webhook.js`

**Problem:**
- GoWA webhook: skip HMAC jika `GOWA_WEBHOOK_SECRET` kosong (line 62, 129)
- WaHA webhook: skip verifikasi jika header `x-hub-signature-256` hilang (line 163-164)

**Solution:**
```javascript
// GoWA webhook verification (line ~62, ~129)
const secret = config.gowebhookSecret;
if (!secret) {
  console.error('FATAL: GOWA_WEBHOOK_SECRET must be set for GoWA webhook verification');
  return res.status(500).json({ error: 'Webhook secret not configured' });
}
// LANJUTKAN dengan verifikasi HMAC...

// WaHA webhook verification (line ~163-164)
const signature = req.headers['x-hub-signature-256'];
if (!signature) {
  console.error('Missing x-hub-signature-256 header for WaHA webhook');
  return res.status(401).json({ error: 'Missing signature header' });
}
// LANJUTKAN dengan verifikasi...
```

**Verification:**
- Kirim fake webhook tanpa signature → harus 401
- Start app tanpa `GOWA_WEBHOOK_SECRET` → harus error 500

---

### Phase 2: Performance Optimization (HIGH)

**Target:** 2-3 hari

#### 2.1 Fix Synchronous Storage Operations (CRITICAL)
**Files:** `chat-store.ts` (1383 lines, 27x synchronous `sessionStorage`)

**Problem:** 
- `sessionStorage.getItem/setItem` dipanggil secara synchronous
- Blocking main thread, bisa cause UI freeze

**Solution:**
```typescript
// BEFORE (BLOCKING)
const data = sessionStorage.getItem('chat_history');
this.history = JSON.parse(data || '[]');

// AFTER (ASYNC with useEffect)
useEffect(() => {
  const loadHistory = async () => {
    const data = await new Promise<string | null>((resolve) => {
      resolve(sessionStorage.getItem('chat_history'));
    });
    if (data) {
      this.history = JSON.parse(data);
    }
  };
  loadHistory();
}, []);

// ATAU gunakan localStorage dengan async wrapper:
const asyncSessionStorage = {
  getItem: (key: string) => Promise.resolve(sessionStorage.getItem(key)),
  setItem: (key: string, value: string) => Promise.resolve(sessionStorage.setItem(key, value)),
};
```

**Verification:**
- `grep -n "sessionStorage\." chat-store.ts` → hitung jumlah (harus 0 atau pindah ke async)
- Test UI responsiveness dengan Chrome DevTools Performance tab

---

#### 2.2 Add React.memo to List Components (HIGH)
**Files:** 
- `export-menu.tsx`
- `error-toast.tsx`  
- `MobileSetupModal.tsx`

**Problem:** Re-render tidak perlu pada komponen list

**Solution:**
```tsx
// BEFORE
export function ExportMenu(props) { ... }

// AFTER
import React, { memo } from 'react';

export const ExportMenu = memo(function ExportMenu(props) { ... });
// ATAU
const ExportMenu = memo((props) => { ... });
export default ExportMenu;
```

**Verification:**
- React DevTools Profiler: render count harus turun
- `grep -n "export.*function\|const.*=.*(" *.tsx | grep -i "export\|menu\|toast\|modal"` untuk identifikasi komponen lain

---

#### 2.3 Fix Synchronous File I/O in Node.js (HIGH)
**Files:** `swarm-roster.ts` (readFileSync/writeFileSync)

**Problem:** Blocking event loop Node.js dengan sync I/O

**Solution:**
```typescript
// BEFORE (BLOCKING)
const data = fs.readFileSync('roster.json', 'utf-8');
fs.writeFileSync('roster.json', JSON.stringify(data));

// AFTER (ASYNC)
import { promises as fs } from 'fs';

const data = await fs.readFile('roster.json', 'utf-8');
await fs.writeFile('roster.json', JSON.stringify(data));
```

**Verification:**
- `grep -rn "readFileSync\|writeFileSync" src/` harus tidak ada hasil (kecuali di startup)
- Load test dengan `ab` atau `wrk` → response time harus stabil

---

#### 2.4 Add Debounce/Throttle to Input Handlers (MEDIUM)
**Files:** Audit semua input handlers (search, text input, etc.)

**Solution:**
```typescript
import { debounce } from 'lodash';

const handleSearch = debounce((query: string) => {
  // API call atau filter
}, 300);

// ATAU native implementation:
function debounce<T extends (...args: any[]) => any>(fn: T, delay: number): T {
  let timer: NodeJS.Timeout;
  return ((...args: any[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  }) as T;
}
```

**Verification:**
- `grep -rn "onChange\|onInput\|onSearch" src/` → cek apakah sudah ada debounce
- Test dengan rapid typing → API calls harus throttled

---

#### 2.5 Audit Array Operations (MEDIUM)
**Problem:** 1722 array method calls terdeteksi, perlu audit untuk dataset besar

**Solution:**
1. Identifikasi operasi pada dataset > 100 items
2. Ganti `.filter().map()` dengan single loop
3. Gunakan `for...of` atau `reduce` untuk operasi kompleks
4. Consider virtualization untuk list panjang (react-window)

**Verification:**
- `grep -rn "\.filter\|\.map\|\.reduce\|\.forEach" src/ | wc -l` → baseline
- Profile dengan dataset 1000+ items → harus < 16ms per frame

---

### Phase 3: Innovation Implementation (MEDIUM)

**Target:** 1 minggu

#### 3.1 Smart UX Adaptive Feature (dari Tim Ide)

**Concept:** Sistem personalisasi UI/UX dinamis yang menyesuaikan tata letak, ukuran elemen, dan prioritas fitur berdasarkan riwayat interaksi user.

**Design:**

```typescript
// UserInteractionTracker.ts
interface InteractionEvent {
  type: 'click' | 'hover' | 'scroll' | 'duration';
  element: string;
  timestamp: number;
  duration?: number; // untuk 'duration' type
}

class UserInteractionTracker {
  private events: InteractionEvent[] = [];
  
  trackClick(element: string) {
    this.events.push({ type: 'click', element, timestamp: Date.now() });
    this.persist();
  }
  
  trackDuration(element: string, duration: number) {
    this.events.push({ type: 'duration', element, timestamp: Date.now(), duration });
    this.persist();
  }
  
  // Analisis pola
  getFrequentElements(): string[] {
    const clickCounts = this.events
      .filter(e => e.type === 'click')
      .reduce((acc, e) => { acc[e.element] = (acc[e.element] || 0) + 1; return acc; }, {});
    return Object.entries(clickCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([element]) => element);
  }
  
  getPreferredLayout(): 'compact' | 'comfortable' | 'spacious' {
    const avgDuration = this.events
      .filter(e => e.type === 'duration')
      .reduce((sum, e) => sum + (e.duration || 0), 0) / this.events.length;
    if (avgDuration > 5000) return 'comfortable';
    if (avgDuration > 2000) return 'spacious';
    return 'compact';
  }
  
  private persist() {
    // Save to localStorage (privacy-friendly, on-device)
    localStorage.setItem('ux_interactions', JSON.stringify(this.events.slice(-100))); // keep last 100
  }
}

// AdaptiveLayout.tsx
function AdaptiveLayout({ children }) {
  const [layout, setLayout] = useState<'compact' | 'comfortable' | 'spacious'>('compact');
  const tracker = new UserInteractionTracker();
  
  useEffect(() => {
    setLayout(tracker.getPreferredLayout());
  }, []);
  
  return (
    <div className={`layout-${layout}`}>
      {children}
    </div>
  );
}
```

**Implementation Steps:**
1. Buat `UserInteractionTracker` class
2. Integrate dengan event handlers di komponen utama
3. Buat `AdaptiveLayout` wrapper
4. Tambah CSS classes untuk 3 layout modes
5. A/B test: bandingkan engagement sebelum vs sesudah

**Privacy:**
- Data diproses di perangkat (localStorage)
- Tidak dikirim ke server
- User bisa opt-out

**Verification:**
- Test dengan fake interactions → layout harus berubah
- Check localStorage → data harus ada
- Opt-out → tracker harus stop

---

## Wikipedia References

1. **Software Design:** https://en.wikipedia.org/wiki/Software_design
   - "Software design is the process of envisioning and defining software solutions to one or more sets of problems."

2. **System Architecture:** https://en.wikipedia.org/wiki/Systems_architecture
   - "Systems architecture is the conceptual model that defines the structure, behavior, and more views of a system."

3. **Planning:** https://en.wikipedia.org/wiki/Planning
   - "Planning is the process of thinking about the activities required to achieve a desired goal."

4. **Security by Design:** https://en.wikipedia.org/wiki/Secure_by_design
   - "Secure by design means that the software has been designed from the foundation to be secure."

5. **Performance Engineering:** https://en.wikipedia.org/wiki/Performance_engineering
   - "Performance engineering encompasses the techniques applied during a systems development lifecycle to ensure non-functional requirements for performance."

---

## Priority Matrix

| Item | Severity | Effort | Risk if Delayed | Owner |
|------|----------|--------|-----------------|-------|
| 1.1 Fix Default Empty Secrets | CRITICAL | 1h | JWT forgery, admin bypass | Tim Perancang |
| 1.2 Remove Hardcoded Telegram Creds | CRITICAL | 1h | Token compromise | Tim Perancang |
| 1.3 Fix Webhook Verification | HIGH | 2h | Fake webhooks | Tim Perancang |
| 2.1 Fix Sync Storage | CRITICAL | 4h | UI freeze | Tim Dokter |
| 2.2 Add React.memo | HIGH | 2h | Slow re-renders | Tim Dokter |
| 2.3 Fix Sync File I/O | HIGH | 2h | Blocked event loop | Tim Dokter |
| 2.4 Add Debounce/Throttle | MEDIUM | 3h | Excessive API calls | Tim Dokter |
| 2.5 Audit Array Ops | MEDIUM | 4h | Slow operations | Tim Dokter |
| 3.1 Smart UX Adaptive | MEDIUM | 1 week | N/A (innovation) | Tim Ide + Tim Sandiwara |

---

## Success Metrics

### Security:
- [ ] 0 hardcoded credentials di codebase
- [ ] 0 default empty secrets
- [ ] 100% webhook requests terverifikasi
- [ ] Security scan (OWASP ZAP) → 0 high/critical issues

### Performance:
- [ ] chat-store.ts: 0 synchronous storage calls
- [ ] Main thread blocking < 50ms (Chrome DevTools)
- [ ] Node.js event loop lag < 10ms (under load)
- [ ] Re-render count turun 50% (React Profiler)

### Innovation:
- [ ] Smart UX Adaptive live & tracking
- [ ] User engagement +20% (click-through rate)
- [ ] User satisfaction survey > 4/5

---

## Next Steps

1. **Tim Perancang:** Present plan ke Forum Diskusi (30 menit)
2. **Forum Diskusi:** Vote & approve plan
3. **Tim Perancang:** Assign tasks ke tim spesifik (via agent-comm-board.json)
4. **All Teams:** Execute assigned tasks
5. **Tim Informasi:** Monitor progress & report

---

**Plan Status:** DRAFT - Menunggu persetujuan Forum Diskusi
**Estimated Total Effort:** 2-3 hari (Phase 1 + 2), 1 minggu (Phase 3)
**Risk Level:** HIGH (jika Phase 1 delay > 24 jam)

import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfmake = require("pdfmake");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vfsFonts = require("pdfmake/build/vfs_fonts");

const _vfs = vfsFonts as Record<string, string>;
Object.keys(_vfs).forEach((name) => {
  pdfmake.virtualfs.writeFileSync(name, _vfs[name], "base64");
});
pdfmake.addFonts({
  Roboto: {
    normal: "Roboto-Regular.ttf",
    bold: "Roboto-Medium.ttf",
    italics: "Roboto-Italic.ttf",
    bolditalics: "Roboto-MediumItalic.ttf"
  }
});

const _dir = dirname(fileURLToPath(import.meta.url));
const _fontsDir = join(_dir, "../assets/fonts");
let _fontName = "Roboto";
try {
  const r  = join(_fontsDir, "NotoSans-Regular.ttf");
  const b  = join(_fontsDir, "NotoSans-Bold.ttf");
  const i  = join(_fontsDir, "NotoSans-Italic.ttf");
  const bi = join(_fontsDir, "NotoSans-BoldItalic.ttf");
  if (existsSync(r) && existsSync(b)) {
    pdfmake.virtualfs.writeFileSync("NotoSans-Regular.ttf",    readFileSync(r));
    pdfmake.virtualfs.writeFileSync("NotoSans-Bold.ttf",       readFileSync(b));
    pdfmake.virtualfs.writeFileSync("NotoSans-Italic.ttf",     existsSync(i)  ? readFileSync(i)  : readFileSync(r));
    pdfmake.virtualfs.writeFileSync("NotoSans-BoldItalic.ttf", existsSync(bi) ? readFileSync(bi) : readFileSync(b));
    pdfmake.addFonts({
      NotoSans: {
        normal: "NotoSans-Regular.ttf",
        bold:   "NotoSans-Bold.ttf",
        italics:      "NotoSans-Italic.ttf",
        bolditalics:  "NotoSans-BoldItalic.ttf"
      }
    });
    _fontName = "NotoSans";
  }
} catch { /* Roboto fallback */ }

const _logoPath = join(_dir, "../assets/logo.jpg");
let _logoDataUrl: string | null = null;
try {
  if (existsSync(_logoPath)) {
    _logoDataUrl = `data:image/jpeg;base64,${readFileSync(_logoPath).toString("base64")}`;
  }
} catch { /* no logo */ }

// ── Constants ─────────────────────────────────────────────────────────────────

const BRAND  = "#1565C0";
const LIGHT  = "#E3F2FD";
const ALT    = "#F8FAFB";
const GREY   = "#666666";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ReportDocEntry = {
  type: string;        // "order" | "demand" | "paymentin" | "cashin" | "paymentout" | "cashout" | "supply" | "salesreturn"
  name: string;        // MoySklad document name, e.g. "ЗК-00001"
  moment: string;      // MoySklad moment string
  sum: number;         // already in human units (divided by 100)
  state?: string | null;
  positions?: Array<{ name: string; quantity: number; price: number | null }>;
};

export type ReportPdfParams = {
  lang: string;
  periodLabel: string;
  generatedAt: Date;
  clientName: string;
  clientPhone: string;
  entries: ReportDocEntry[];
  balance: number | null;
  currencyCode: string | null;
};

// ── Localisation ──────────────────────────────────────────────────────────────

function L(lang: string) {
  if (lang === "ru") return {
    title:      "ОТЧЁТ",
    period:     "Период",
    generated:  "Сформировано",
    client:     "Клиент",
    name:       "Имя",
    phone:      "Телефон",
    summary:    "Сводка",
    balance:    "Баланс",
    debt:       "Пожалуйста, завершите оплату.",
    detail:     "Документы",
    colNo:      "№",
    colDate:    "Дата",
    colType:    "Тип",
    colDoc:     "Документ",
    colSum:     "Сумма",
    colStatus:  "Статус",
    noData:     "Нет документов за выбранный период.",
    page:       "Стр.",
    types: {
      order:       "Заказ",
      demand:      "Отгрузка",
      paymentin:   "Платёж (вход.)",
      cashin:      "Касса (вход.)",
      paymentout:  "Платёж (исход.)",
      cashout:     "Касса (исход.)",
      supply:      "Приёмка",
      salesreturn: "Возврат",
    },
    countUnit: "шт."
  };

  if (lang === "uzc") return {
    title:      "ҲИСОБОТ",
    period:     "Давр",
    generated:  "Тузилди",
    client:     "Мижоз",
    name:       "Исм",
    phone:      "Телефон",
    summary:    "Хулоса",
    balance:    "Баланс",
    debt:       "Илтимос, тўловни якунланг.",
    detail:     "Ҳужжатлар",
    colNo:      "№",
    colDate:    "Сана",
    colType:    "Тури",
    colDoc:     "Ҳужжат",
    colSum:     "Жами",
    colStatus:  "Ҳолат",
    noData:     "Танланган давр учун ҳужжат йўқ.",
    page:       "Бет",
    types: {
      order:       "Буюртма",
      demand:      "Йетказма",
      paymentin:   "Тўлов (кирим)",
      cashin:      "Касса кирим",
      paymentout:  "Тўлов (чиқим)",
      cashout:     "Касса чиқим",
      supply:      "Товар қабул",
      salesreturn: "Қайтариш",
    },
    countUnit: "ta"
  };

  return {
    title:      "HISOBOT",
    period:     "Davr",
    generated:  "Tuzildi",
    client:     "Mijoz",
    name:       "Ism",
    phone:      "Telefon",
    summary:    "Xulosa",
    balance:    "Balans",
    debt:       "Iltimos, to'lovni yakunlang.",
    detail:     "Hujjatlar",
    colNo:      "№",
    colDate:    "Sana",
    colType:    "Turi",
    colDoc:     "Hujjat",
    colSum:     "Jami",
    colStatus:  "Holat",
    noData:     "Tanlangan davr uchun hujjat yo'q.",
    page:       "Bet",
    types: {
      order:       "Buyurtma",
      demand:      "Yetkazma",
      paymentin:   "To'lov (kirim)",
      cashin:      "Kassa kirim",
      paymentout:  "To'lov (chiqim)",
      cashout:     "Kassa chiqim",
      supply:      "Tovar qabul",
      salesreturn: "Qaytarish",
    },
    countUnit: "ta"
  };
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtDate(moment: string): string {
  const d = new Date(moment.replace(" ", "T"));
  if (isNaN(d.getTime())) return moment;
  const dd  = String(d.getDate()).padStart(2, "0");
  const mm  = String(d.getMonth() + 1).padStart(2, "0");
  const hh  = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${dd}.${mm}.${d.getFullYear()} ${hh}:${min}`;
}

function fmtNow(d: Date): string {
  const dd  = String(d.getDate()).padStart(2, "0");
  const mm  = String(d.getMonth() + 1).padStart(2, "0");
  const hh  = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${dd}.${mm}.${d.getFullYear()} ${hh}:${min}`;
}

function fmtMoney(amount: number, currency: string | null): string {
  const code = (currency || "").toUpperCase();
  const text = (Math.round(amount * 100) / 100).toLocaleString("ru-RU", {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });
  const label =
    code === "USD" ? "USD" :
    code === "EUR" ? "EUR" :
    code === "RUB" ? "руб." :
    code === "UZS" ? "сум" :
    code || "";
  return label ? `${text} ${label}` : text;
}

function localizeStatus(raw: string | null | undefined, lang: string): string {
  if (!raw) return "";
  const n = raw.trim().toLowerCase();
  const map: Record<string, { uz: string; uzc: string; ru: string }> = {
    "подтвержден":  { uz: "Tasdiqlandi",   uzc: "Тасдиқланди",   ru: "Подтверждён" },
    "подтверждено": { uz: "Tasdiqlandi",   uzc: "Тасдиқланди",   ru: "Подтверждён" },
    "собирается":   { uz: "Yig'ilmoqda",   uzc: "Йиғилмоқда",    ru: "Собирается"  },
    "отгружен":     { uz: "Yuklandi",      uzc: "Юкланди",       ru: "Отгружен"    },
    "отгружено":    { uz: "Yuklandi",      uzc: "Юкланди",       ru: "Отгружен"    },
    "доставляется": { uz: "Yetkazilmoqda", uzc: "Йетказилмоқда", ru: "Доставляется"},
    "отменен":      { uz: "Bekor qilindi", uzc: "Бекор қилинди", ru: "Отменён"     },
    "отменено":     { uz: "Bekor qilindi", uzc: "Бекор қилинди", ru: "Отменён"     },
    "новый":        { uz: "Yangi",         uzc: "Янги",          ru: "Новый"       },
    "выполнен":     { uz: "Bajarildi",     uzc: "Бажарилди",     ru: "Выполнен"    },
  };
  const entry = map[n];
  if (entry) return lang === "ru" ? entry.ru : lang === "uzc" ? entry.uzc : entry.uz;
  return raw;
}

// ── PDF generator ─────────────────────────────────────────────────────────────

export function generateReportPdf(params: ReportPdfParams): Promise<Buffer> {
  const { lang, periodLabel, generatedAt, clientName, clientPhone, entries, balance, currencyCode } = params;
  const lbl = L(lang);

  // ── Header (logo or colour band) ──────────────────────────────────────────
  const headerContent: any[] = _logoDataUrl
    ? [
        {
          columns: [
            { image: _logoDataUrl, fit: [80, 80], width: 90 },
            {
              stack: [
                { text: "Comfort Textile", fontSize: 18, bold: true, color: BRAND },
                { text: lbl.title, fontSize: 9, color: GREY, characterSpacing: 2, margin: [0, 5, 0, 0] }
              ],
              alignment: "right" as const
            }
          ],
          margin: [0, 0, 0, 8]
        },
        {
          canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 2, lineColor: BRAND }],
          margin: [0, 0, 0, 10]
        }
      ]
    : [
        {
          canvas: [{ type: "rect", x: 0, y: 0, w: 515, h: 52, r: 4, color: BRAND }],
          absolutePosition: { x: 40, y: 40 }
        },
        {
          columns: [
            { text: [
                { text: "Comfort Textile\n", fontSize: 18, bold: true, color: "#ffffff" },
                { text: lbl.title, fontSize: 9, color: LIGHT, characterSpacing: 2 }
              ]
            },
            { text: lbl.title, fontSize: 16, bold: true, color: "#ffffff", alignment: "right" as const }
          ],
          margin: [8, 0, 8, 0]
        },
        { text: "\n" }
      ];

  // ── Period + generated date ────────────────────────────────────────────────
  const metaRow = {
    columns: [
      {
        stack: [
          { text: [{ text: lbl.period + ": ", color: GREY, fontSize: 9 }, { text: periodLabel, bold: true, fontSize: 9 }] },
          { text: [{ text: lbl.generated + ": ", color: GREY, fontSize: 9 }, { text: fmtNow(generatedAt), fontSize: 9 }], margin: [0, 2, 0, 0] }
        ]
      }
    ],
    margin: [0, 4, 0, 12]
  };

  // ── Client box ────────────────────────────────────────────────────────────
  const clientBox = {
    table: {
      widths: ["*"],
      body: [[{
        stack: [
          { text: lbl.client, bold: true, fontSize: 10, color: BRAND, margin: [0, 0, 0, 4] },
          { columns: [{ text: lbl.name + ":", color: GREY, width: 60 }, { text: clientName, bold: true }] },
          { columns: [{ text: lbl.phone + ":", color: GREY, width: 60 }, { text: clientPhone }], margin: [0, 2, 0, 0] }
        ],
        fillColor: LIGHT,
        border: [false, false, false, false],
        margin: [12, 8, 12, 8]
      }]]
    },
    margin: [0, 0, 0, 14]
  };

  // ── Summary box ──────────────────────────────────────────────────────────
  const summaryTypes = ["order", "demand", "paymentin", "cashin", "paymentout", "cashout", "supply", "salesreturn"] as const;
  const summaryRows: any[] = [];
  for (const type of summaryTypes) {
    const typeEntries = entries.filter((e) => e.type === type);
    if (typeEntries.length === 0) continue;
    const total = typeEntries.reduce((s, e) => s + e.sum, 0);
    const typeLabel = lbl.types[type] ?? type;
    summaryRows.push({
      columns: [
        { text: typeLabel + ":", color: GREY, width: 130 },
        { text: `${typeEntries.length} ${lbl.countUnit}`, width: 50 },
        { text: fmtMoney(total, currencyCode), bold: true, alignment: "right" as const }
      ],
      margin: [0, 2, 0, 0]
    });
  }
  if (balance !== null) {
    summaryRows.push({
      canvas: [{ type: "line", x1: 0, y1: 0, x2: 491, y2: 0, lineWidth: 0.5, lineColor: "#B0BEC5" }],
      margin: [0, 6, 0, 4]
    });
    summaryRows.push({
      columns: [
        { text: lbl.balance + ":", color: GREY, width: 130 },
        { text: "", width: 50 },
        { text: fmtMoney(balance, currencyCode), bold: true, color: balance < 0 ? "#C62828" : BRAND, alignment: "right" as const }
      ],
      margin: [0, 0, 0, 0]
    });
    if (balance < 0) {
      summaryRows.push({
        text: "⚠  " + lbl.debt,
        color: "#C62828",
        fontSize: 8,
        margin: [0, 3, 0, 0]
      });
    }
  }

  const summaryBox = summaryRows.length > 0
    ? {
        table: {
          widths: ["*"],
          body: [[{
            stack: [
              { text: lbl.summary, bold: true, fontSize: 10, color: BRAND, margin: [0, 0, 0, 6] },
              ...summaryRows
            ],
            fillColor: LIGHT,
            border: [false, false, false, false],
            margin: [12, 10, 12, 10]
          }]]
        },
        margin: [0, 0, 0, 16]
      }
    : null;

  // ── Documents table ──────────────────────────────────────────────────────
  // Columns: №  |  Date  |  Type  |  Document  |  Sum  |  Status
  const colHeader = [
    { text: lbl.colNo,     bold: true, color: "#fff", fillColor: BRAND, alignment: "center" as const, margin: [3, 5, 3, 5] },
    { text: lbl.colDate,   bold: true, color: "#fff", fillColor: BRAND, margin: [4, 5, 4, 5] },
    { text: lbl.colType,   bold: true, color: "#fff", fillColor: BRAND, margin: [4, 5, 4, 5] },
    { text: lbl.colDoc,    bold: true, color: "#fff", fillColor: BRAND, margin: [4, 5, 4, 5] },
    { text: lbl.colSum,    bold: true, color: "#fff", fillColor: BRAND, alignment: "right" as const, margin: [4, 5, 4, 5] },
    { text: lbl.colStatus, bold: true, color: "#fff", fillColor: BRAND, margin: [4, 5, 4, 5] },
  ];

  const dataRows: any[] = [];
  entries.forEach((e, idx) => {
    const fill = idx % 2 === 0 ? null : ALT;
    const status = localizeStatus(e.state, lang);
    const typeLabel = lbl.types[e.type as keyof typeof lbl.types] ?? e.type;
    dataRows.push([
      { text: String(idx + 1), alignment: "center" as const, fillColor: fill, margin: [3, 4, 3, 4], fontSize: 9 },
      { text: e.moment ? fmtDate(e.moment) : "—", fillColor: fill, margin: [4, 4, 4, 4], fontSize: 9 },
      { text: typeLabel, fillColor: fill, margin: [4, 4, 4, 4], fontSize: 9 },
      { text: e.name, fillColor: fill, margin: [4, 4, 4, 4], fontSize: 9 },
      { text: fmtMoney(e.sum, currencyCode), alignment: "right" as const, fillColor: fill, margin: [4, 4, 4, 4], fontSize: 9 },
      { text: status, fillColor: fill, margin: [4, 4, 4, 4], fontSize: 8, color: GREY },
    ]);
    if (e.positions && e.positions.length > 0) {
      const POSBG = "#EEF3FF";
      const posTableBody = e.positions.map((p) => {
        const unitPrice  = p.price !== null ? fmtMoney(p.price, currencyCode) : "";
        const lineTotal  = p.price !== null ? fmtMoney(p.price * p.quantity, currencyCode) : "";
        return [
          { text: `${p.quantity}×`, fontSize: 8, color: BRAND, bold: true, alignment: "right" as const, noWrap: true, margin: [0, 1, 6, 1] },
          { text: p.name,            fontSize: 8, color: "#333333",                                         margin: [0, 1, 6, 1] },
          { text: unitPrice,         fontSize: 7.5, color: GREY,    alignment: "right" as const,             margin: [0, 1, 6, 1] },
          { text: lineTotal,         fontSize: 8,   color: "#333333", bold: true, alignment: "right" as const, margin: [0, 1, 0, 1] },
        ];
      });
      const posHeader = [
        { text: "",                                                   fontSize: 7, color: GREY, bold: true, margin: [0, 0, 6, 2] },
        { text: lbl.colDoc,  fontSize: 7, color: GREY, bold: true,                              margin: [0, 0, 6, 2] },
        { text: lbl.colSum,  fontSize: 7, color: GREY, bold: true, alignment: "right" as const, margin: [0, 0, 6, 2] },
        { text: lang === "ru" ? "Итого" : lang === "uzc" ? "Жами" : "Jami",
                              fontSize: 7, color: GREY, bold: true, alignment: "right" as const, margin: [0, 0, 0, 2] },
      ];
      dataRows.push([
        { text: "", fillColor: POSBG, margin: [0, 0, 0, 0] },
        {
          colSpan: 5, fillColor: POSBG, margin: [14, 6, 8, 8],
          table: { widths: [16, "*", 76, 82], body: [posHeader, ...posTableBody] },
          layout: "noBorders"
        },
        {}, {}, {}, {}
      ]);
    }
  });

  const tableContent = entries.length > 0
    ? {
        table: {
          headerRows: 1,
          // №=22  Date=86  Type=82  Doc=*  Sum=86  Status=72
          widths: [22, 86, 82, "*", 86, 72],
          body: [colHeader, ...dataRows]
        },
        layout: { hLineWidth: () => 0, vLineWidth: () => 0 }
      }
    : { text: lbl.noData, color: GREY, fontSize: 10, margin: [0, 8, 0, 0] };

  // ── Document definition ───────────────────────────────────────────────────
  const docDefinition: any = {
    pageSize: "A4",
    pageOrientation: entries.length > 30 ? "landscape" : "portrait",
    pageMargins: [40, 50, 40, 60],
    defaultStyle: { font: _fontName, fontSize: 10, color: "#333333" },

    content: [
      ...headerContent,
      metaRow,
      clientBox,
      ...(summaryBox ? [summaryBox] : []),
      { text: lbl.detail, bold: true, fontSize: 11, color: BRAND, margin: [0, 0, 0, 6] },
      tableContent
    ],

    footer: (currentPage: number, pageCount: number) => ({
      columns: [
        { text: `${lbl.generated}: ${fmtNow(generatedAt)}`, color: GREY, fontSize: 8 },
        { text: `${lbl.page} ${currentPage} / ${pageCount}`, alignment: "right" as const, color: GREY, fontSize: 8 }
      ],
      margin: [40, 10, 40, 0]
    }),

    styles: {}
  };

  return pdfmake.createPdf(docDefinition).getBuffer();
}

export function makeReportPdfFilename(period: string, lang: string, tzOffset = 5): string {
  const local = new Date(Date.now() + tzOffset * 3_600_000);
  const y  = local.getUTCFullYear();
  const mm = String(local.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(local.getUTCDate()).padStart(2, "0");
  const prefix = lang === "ru" ? "otchet" : "hisobot";
  return `${prefix}_${period}_${y}${mm}${dd}.pdf`;
}

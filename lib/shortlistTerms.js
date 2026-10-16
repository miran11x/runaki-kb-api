// House wording for the translated Shortlisted FAQ's (set by Miran):
//  Sorani / Badini: customer, CST, BNF = سوودمەند
//  also subscribers = سوودمەند; bill(s) = پسوولە / پسوولەکان (Arabic: فاتورة)
//  meter = پێوەر (Sorani / Badini)
//  Commercial Office / CO: Sorani هۆبەی فرۆشیاری وزە, Badini دائرەی کەهرەب, Arabic دائرة الكهرباء
const CO_AR = 'دائرة الكهرباء', CO_KU = 'هۆبەی فرۆشیاری وزە', CO_BA = 'دائرەی کەهرەب';
const bareCO = /(?<![A-Za-z\/])CO(?![A-Za-z])/g;
function fix(lang, t) {
  if (!t) return t;
  if (lang === 'ku') return t.replace(/ئۆفیسی بازرگانی(?: \(CO\))?/g, CO_KU).replace(bareCO, CO_KU).replace(/کڕیار/g, 'سوودمەند').replace(/بەشداربوو/g, 'سوودمەند').replace(/فاتور/g, 'پسوول').replace(/میتەر/g, 'پێوەر');
  if (lang === 'ba') return t.replace(/ئۆفیسا بازرگانی(?: \(CO\))?/g, CO_BA).replace(bareCO, CO_BA).replace(/کریار/g, 'سوودمەند').replace(/بەشداربوو/g, 'سوودمەند').replace(/فاتور/g, 'پسوول').replace(/میتەر/g, 'پێوەر');
  if (lang === 'ar') return t.replace(/(?:المكتب التجاري|مكتبك التجاري|مكتب تجاري)(?: \(CO\))?/g, CO_AR).replace(bareCO, CO_AR);
  return t;
}
module.exports = { fix };

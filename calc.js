/* Расчёт «под ключ в Москве» — порт src/autopodbor/customs.py + landed.py.
   Правила — из rules.json (выгрузка tools/export_webapp_data.py). Проверка: webapp/test_calc.mjs. */
(function (root) {
  'use strict';
  var KW_PER_HP = 0.73549875;

  function addYears(d, n) {
    var r = new Date(Date.UTC(d.getUTCFullYear() + n, d.getUTCMonth(), d.getUTCDate()));
    if (r.getUTCMonth() !== d.getUTCMonth()) r = new Date(Date.UTC(d.getUTCFullYear() + n, d.getUTCMonth(), 28));
    return r;
  }
  function ageBand(production, on) {
    if (on <= addYears(production, 3)) return 'new';
    if (on <= addYears(production, 5)) return '3_5';
    return 'over_5';
  }
  function first(rows, key, value) {
    for (var i = 0; i < rows.length; i++) if (rows[i][key] === null || value <= rows[i][key]) return rows[i];
    return rows[rows.length - 1];
  }
  function kw(car) { return car.power_kw != null ? car.power_kw : Math.round(car.power_hp * KW_PER_HP * 100) / 100; }
  function isElectric(car) { return car.powertrain === 'ev' || car.powertrain === 'serial_hybrid'; }

  function ettDutyRub(R, car, rates, on) {
    var eur = rates.EUR, band = ageBand(car.production_date, on), duty;
    if (band === 'new') {
      var priceEur = car.price * rates[car.currency] / eur, row = first(R.ett.new_up_to_3y, 'price_eur_to', priceEur);
      duty = Math.max(priceEur * row.pct / 100, car.engine_cc * row.min_eur_per_cc);
    } else {
      var rows = band === '3_5' ? R.ett.age_3_to_5 : R.ett.over_5;
      duty = car.engine_cc * first(rows, 'cc_to', car.engine_cc).eur_per_cc;
    }
    return duty * eur;
  }

  function utilRub(R, car, on, personal) {
    var table = (isElectric(car) ? 'ev' : 'ice') + (personal ? '_personal' : '_commercial');
    var rows = R.util.tables[table];
    if (!isElectric(car)) rows = rows.filter(function (r) {
      return (r.cc_to === null || car.engine_cc <= r.cc_to) && car.engine_cc > r.cc_from;
    });
    var row = first(rows, 'kw_to', kw(car));
    var year = String(Math.min(Math.max(on.getUTCFullYear(), 2026), 2030));
    var c = row.coef[year][ageBand(car.production_date, on) === 'new' ? 'new' : 'older_3y'];
    return Math.round(R.util.base_rate_rub * c * 100) / 100;
  }

  function nearKwBoundary(R, car, personal) {
    var table = (isElectric(car) ? 'ev' : 'ice') + (personal ? '_personal' : '_commercial');
    return R.util.tables[table].some(function (r) { return r.kw_to !== null && Math.abs(kw(car) - r.kw_to) <= 1; });
  }

  function calcCustoms(R, car, rates, on, personal) {
    if (personal === undefined) personal = true;
    var valueRub = car.price * rates[car.currency], flags = [], duty, excise = 0, vat = 0;
    if (car.powertrain === 'ev') {
      duty = valueRub * R.ev.duty_pct / 100;
      excise = car.power_hp * first(R.ev.excise_rub_per_hp, 'hp_to', car.power_hp).rate;
      vat = (valueRub + duty + excise) * R.ev.vat_pct / 100;
      flags.push('Электромобиль: не единая ставка, а пошлина 15 % + акциз + НДС 22 %.');
    } else {
      duty = ettDutyRub(R, car, rates, on);
      if (ageBand(car.production_date, on) === 'new')
        flags.push('До 3 лет: таможня считает пошлину от каталожной розничной цены, а не от цены покупки — реальная пошлина может быть выше.');
    }
    var util = utilRub(R, car, on, personal);
    var lim = isElectric(car) ? [58.84, 80] : [117.68, 160];
    var preferential = personal && kw(car) <= lim[0] && car.engine_cc <= 3000;
    if (personal) {
      flags.push(preferential
        ? 'Льготный утильсбор: машину нельзя продать 12 мес. с даты ТПО (иначе доплата до коммерческого), второй льготный ввоз — через 12 мес.'
        : 'Льготный утильсбор не положен (> ' + lim[0] + ' кВт ≈ ' + lim[1] + ' л.с. или > 3000 см³): коэффициенты как у коммерческого ввоза.');
    }
    if (car.power_kw == null && nearKwBoundary(R, car, personal))
      flags.push('Мощность ' + kw(car) + ' кВт — у границы диапазона утильсбора. Сумма зависит от кВт в ЭПТС/ОТТС (не округляется) — уточнить по документам до покупки.');
    if (car.powertrain === 'hybrid' || car.powertrain === 'serial_hybrid')
      flags.push('Гибрид: мощность для утильсбора — суммарная по документам; проверить у брокера.');
    var fee = first(R.customs_fee, 'value_rub_to', valueRub).fee;
    return { duty: duty, excise: excise, vat: vat, fee: fee, util: util, util_personal: preferential, flags: flags,
             total: duty + excise + vat + fee + util };
  }

  function exportCheck(R, country, car, priceUsd) {
    var r = R.export_restrictions[country] || {}, msgs = [], hybrid = car.powertrain === 'hybrid' || car.powertrain === 'serial_hybrid';
    if (r.max_cc != null && car.engine_cc > r.max_cc) msgs.push('ЗАПРЕТ: экспорт в РФ авто > ' + r.max_cc + ' см³.');
    if (r.hybrid_banned && hybrid) msgs.push('ЗАПРЕТ: экспорт гибридов в РФ.');
    if (r.ev_banned && car.powertrain === 'ev') msgs.push('ЗАПРЕТ: экспорт электромобилей в РФ.');
    if (r.max_price_usd != null && priceUsd > r.max_price_usd)
      msgs.push('ЗАПРЕТ: экспорт в РФ авто дороже $' + String(r.max_price_usd).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + '.');
    if (r.on_violation === 'risk')
      return { blocked: false, msgs: msgs.map(function (m) { return m.replace('ЗАПРЕТ:', 'РИСК (ЕС запрещает):'); }) };
    var blocked = msgs.length > 0;
    if (r.max_cc_without_permit != null && car.engine_cc > r.max_cc_without_permit) {
      msgs.push('> ' + r.max_cc_without_permit + ' см³ — нужно экспортное разрешение страны (на практике закрыто).');
      blocked = true;
    }
    return { blocked: blocked, msgs: msgs };
  }

  function costRub(c, rates, priceRub, body) {
    if (c.pct) return [priceRub * c.pct[0] / 100, priceRub * c.pct[1] / 100];
    var lo, hi;
    if (c.by_body) {
      if (body) { lo = c.by_body[body][0]; hi = c.by_body[body][1]; }
      else {
        var v = Object.keys(c.by_body).map(function (k) { return c.by_body[k]; });
        lo = Math.min.apply(null, v.map(function (x) { return x[0]; }));
        hi = Math.max.apply(null, v.map(function (x) { return x[1]; }));
      }
    } else { lo = c.range[0]; hi = c.range[1]; }
    return [lo * rates[c.cur], hi * rates[c.cur]];
  }

  function landed(R, car, country, rates, on, opts) {
    opts = opts || {};
    var personal = opts.personal !== false, repair = opts.repair || 0, body = opts.body || null;
    var route = R.routes[country], priceRub = car.price * rates[car.currency];
    var costs = route.costs.map(function (c) {
      var r = costRub(c, rates, priceRub, body);
      return { item: c.item, lo: r[0], hi: r[1], confidence: c.confidence, source: c.source };
    });
    var ex = exportCheck(R, country, car, priceRub / rates.USD);
    var customs = calcCustoms(R, car, rates, on, personal);
    var notes = (route.notes || []).slice();
    if (isElectric(car)) notes = notes.concat(route.notes_electric || []);
    var flags = ex.msgs.concat(notes, customs.flags);
    if (route.status !== 'ok') flags.unshift('Маршрут: ' + route.status + '.');
    var sum = function (k) { return costs.reduce(function (s, c) { return s + c[k]; }, 0); };
    return {
      country: country, name: route.name, status: route.status, days: route.days, priceRub: priceRub,
      costs: costs, customs: customs, repair: repair, blocked: ex.blocked,
      flags: flags,
      totalMin: priceRub + sum('lo') + customs.total + repair,
      totalMax: priceRub + sum('hi') + customs.total + repair,
      lowConfidence: costs.filter(function (c) { return c.confidence === 'low'; }).reduce(function (s, c) { return s + c.hi; }, 0)
    };
  }

  var api = { ageBand: ageBand, calcCustoms: calcCustoms, utilRub: utilRub, exportCheck: exportCheck, landed: landed, KW_PER_HP: KW_PER_HP };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.APCalc = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

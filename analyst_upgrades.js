/* =
   ANALYST UPGRADES v2.0 — Mejoras de nivel profesional avanzado
   -
   Este parche INCLUYE las 8 mejoras de v1.x y AÑADE 6 nuevas:

   v1.x (recapitulación):
     #1 Veredicto condicional no lineal
     #2 Data sanity check de inputs
     #3 FV Confidence LOW bloquea COMPRAR
     #4 Pesos del manual en score global
     #5 "No sé" neutral en checklist
     #6 Stress test cuantitativo
     #7 Métrica de convicción
     #8 Alerta sector "general"

   v2 (NUEVAS):
     #9  Devil's Advocate — exige justificación en preguntas críticas respondidas "Sí"
     #10 Cross-validation — detecta inconsistencias entre métricas relacionadas
     #11 Detección de ciclicidad — pico de ciclo vs tendencia secular
     #12 Sensibilidad del DCF — upside con WACC+1% y g-1%
     #13 Ajustes IFRS/mercado europeo — reconocimiento y tolerancias
     #14 Análisis temporal — deterioro reciente vs tendencia larga

   = */

(function () {
  'use strict';

  if (typeof runFullAnalysis !== 'function') {
    console.warn('[AnalystUpgrades v2] Motor base no detectado.');
    return;
  }

  // =
  // v1 — PESOS DEL MANUAL
  // =
  const MANUAL_WEIGHTS = {
    m1: 20, m2: 15, m3: 20, m4: 10, m5: 10,
    m6: 10, m7: 10, m8: 3, m9: 2,
  };
  const MANUAL_WEIGHTS_NO_DIV = { ...MANUAL_WEIGHTS, m8: 0, m7: 13 };

  window.computeGlobalScore = function (R) {
    const m = R.modules;
    const useWeights = m.m8 && m.m8.noDividend ? MANUAL_WEIGHTS_NO_DIV : MANUAL_WEIGHTS;
    let weighted = 0, totalW = 0;
    for (const [k, w] of Object.entries(useWeights)) {
      if (!m[k] || w === 0) continue;
      weighted += m[k].score * w;
      totalW += w;
    }
    let pct = Math.round((weighted / totalW) * 100);
    if (!R.m0.passes) pct = Math.min(pct, 40);
    return pct;
  };

  // =
  // UTILIDADES COMPARTIDAS
  // =
  function num(metrics, k) {
    const v = metrics[k];
    const raw = v && typeof v === 'object' && 'value' in v ? v.value : v;
    if (raw == null) return null;
    const n = parseFloat(String(raw).replace(/[%,$€£\s]/g, '').replace(',', '.'));
    return isNaN(n) ? null : n;
  }
  function getRaw(metrics, k) {
    const v = metrics[k];
    return v && typeof v === 'object' && 'value' in v ? v.value : v;
  }

  // =
  // v1 #2 — DATA SANITY
  // =
  function runDataSanity(metrics) {
    const alerts = [];
    const roic = num(metrics, 'roic');
    const roe = num(metrics, 'roe');
    const gpM = num(metrics, 'gp_margin');
    const niM = num(metrics, 'ni_margin');
    const fcfToNI = num(metrics, 'fcf_to_ni');
    const peFwd = num(metrics, 'pe_fwd');
    const peLtm = num(metrics, 'pe_ltm');
    const revG = num(metrics, 'total_rev_growth');
    const epsG = num(metrics, 'eps_diluted_growth');

    if (roic != null && roic > 50) alerts.push({ severity: 'warn', metric: 'ROIC', value: roic,
      msg: `ROIC de ${roic.toFixed(1)}% es extraordinariamente alto. Verifica: (a) goodwill neto negativo, (b) activos fuera de balance, (c) one-off en NOPAT.` });
    if (roic != null && roe != null && roe < roic - 5 && roe > 0) alerts.push({ severity: 'info', metric: 'ROE<ROIC',
      msg: `ROE (${roe.toFixed(1)}%) < ROIC (${roic.toFixed(1)}%). Inusual — normalmente apalancamiento amplifica ROE.` });
    if (gpM != null && gpM > 95) alerts.push({ severity: 'warn', metric: 'Gross Margin', value: gpM,
      msg: `Margen bruto de ${gpM.toFixed(1)}% es casi imposible con COGS real. Verifica clasificación COGS/OpEx.` });
    if (niM != null && niM > 60) alerts.push({ severity: 'warn', metric: 'Net Margin', value: niM,
      msg: `Margen neto del ${niM.toFixed(1)}% sugiere one-off. No extrapolar al futuro.` });
    if (fcfToNI != null && (fcfToNI > 200 || fcfToNI < -50)) alerts.push({ severity: 'warn', metric: 'FCF/NI', value: fcfToNI,
      msg: `FCF/NI del ${fcfToNI.toFixed(0)}% fuera de rango normal (60-130%). Beneficio y caja desacoplados.` });
    if (peFwd != null && peLtm != null && peFwd > 0 && peLtm > 0) {
      const ratio = peLtm / peFwd;
      if (ratio > 3) alerts.push({ severity: 'info', metric: 'PE shift', value: ratio,
        msg: `PER LTM es ${ratio.toFixed(1)}x el Fwd — mercado anticipa salto de beneficios.` });
      if (ratio < 0.3) alerts.push({ severity: 'warn', metric: 'PE shift', value: ratio,
        msg: `PER Fwd muy superior al LTM — analistas esperan CAÍDA de beneficios.` });
    }
    if (revG != null && epsG != null && Math.abs(epsG) > 200 && Math.abs(revG) < 30) alerts.push({ severity: 'info', metric: 'EPS vs Rev',
      msg: `EPS (${epsG.toFixed(0)}%) muy dispar con Revenue (${revG.toFixed(0)}%). One-off o recompras agresivas.` });

    return alerts;
  }

  // =
  // v2 #10 — CROSS-VALIDATION DE MÉTRICAS
  // =
  // Detecta inconsistencias lógicas entre métricas que deberían concordar.
  // Si hay discrepancias, el input del proveedor tiene problemas.
  function runCrossValidation(metrics) {
    const alerts = [];

    // Check 1: FCF = OCF - CapEx debe cuadrar aproximadamente con fcf_levered
    const ocfM = num(metrics, 'cash_from_operations_margin');
    const capexM = num(metrics, 'capex_margin');
    const fcfM = num(metrics, 'fcf_margin');
    if (ocfM != null && capexM != null && fcfM != null) {
      const implied = ocfM - Math.abs(capexM);
      const diff = Math.abs(implied - fcfM);
      if (diff > 3) {
        alerts.push({
          severity: 'warn',
          title: 'FCF no cuadra con OCF − CapEx',
          msg: `OCF margin ${ocfM.toFixed(1)}% − CapEx margin ${Math.abs(capexM).toFixed(1)}% ≈ ${implied.toFixed(1)}%, pero FCF margin reportado es ${fcfM.toFixed(1)}% (diferencia: ${diff.toFixed(1)}pp). Puede haber working capital atípico, leases capitalizados o otros ítems.`
        });
      }
    }

    // Check 2: ROIC debe estar en el rango (ROA, ROE). Si está fuera, hay algo raro.
    const roic = num(metrics, 'roic');
    const roa = num(metrics, 'roa');
    const roe = num(metrics, 'roe');
    if (roic != null && roa != null && roe != null) {
      const min = Math.min(roa, roe);
      const max = Math.max(roa, roe);
      // ROIC suele estar entre ROA y ROE (sin apalancamiento extremo)
      if (roic < min - 3 || roic > max + 3) {
        alerts.push({
          severity: 'info',
          title: 'ROIC fuera del rango (ROA, ROE)',
          msg: `ROIC=${roic.toFixed(1)}% vs ROA=${roa.toFixed(1)}%, ROE=${roe.toFixed(1)}%. Suele estar entre los dos. Posible causa: intangibles/goodwill grande, tasa impositiva atípica, o definición de capital invertido no estándar.`
        });
      }
    }

    // Check 3: Net margin × asset turnover ≈ ROA (DuPont)
    const assetTO = num(metrics, 'asset_turnover');
    const niM = num(metrics, 'ni_margin');
    if (niM != null && assetTO != null && roa != null) {
      const impliedROA = niM * assetTO / 100;
      const diff = Math.abs(impliedROA - roa);
      if (diff > 2 && roa !== 0) {
        alerts.push({
          severity: 'info',
          title: 'DuPont: Net Margin × Asset Turnover no cuadra con ROA',
          msg: `NM (${niM.toFixed(1)}%) × Asset TO (${assetTO.toFixed(2)}) = ${impliedROA.toFixed(1)}% vs ROA reportado ${roa.toFixed(1)}%. Activos medios vs finales puede explicarlo.`
        });
      }
    }

    // Check 4: Earnings yield ≈ 1/PER
    const earnYield = num(metrics, 'earnings_yield_ltm');
    const peLtm = num(metrics, 'pe_ltm');
    if (earnYield != null && peLtm != null && peLtm > 0) {
      const implied = 100 / peLtm;
      const diff = Math.abs(implied - earnYield);
      if (diff > 1) {
        alerts.push({
          severity: 'info',
          title: 'Earnings Yield no es 1/PER',
          msg: `1/PER = ${implied.toFixed(1)}% vs Earnings Yield reportado ${earnYield.toFixed(1)}%. Puede usar beneficio ajustado distinto.`
        });
      }
    }

    // Check 5: Dividend yield × payout ratio ≈ earnings yield
    const divYield = num(metrics, 'div_yield') || num(metrics, 'dividend_yield');
    const payoutR = num(metrics, 'payout_ratio') || num(metrics, 'div_payout_ratio');
    if (divYield != null && payoutR != null && earnYield != null && payoutR > 5) {
      const implied = earnYield * (payoutR / 100);
      const diff = Math.abs(implied - divYield);
      if (diff > 0.5) {
        alerts.push({
          severity: 'info',
          title: 'Dividend yield vs payout ratio',
          msg: `Earnings Yield × Payout = ${implied.toFixed(1)}% vs Div Yield ${divYield.toFixed(1)}%. Diferencia puede indicar recompras significativas o dividendos especiales.`
        });
      }
    }

    return alerts;
  }

  // =
  // v2 #11 — DETECCIÓN DE CICLICIDAD
  // =
  // Compara CAGR 3y/5y/10y. Si 3y >> 10y, los beneficios actuales están
  // probablemente en pico de ciclo y no son extrapolables.
  function detectCyclicality(metrics, sectorKey) {
    const result = { detected: false, severity: 'info', signals: [], verdict: null };

    const rev3 = num(metrics, 'total_rev_cagr_3y');
    const rev5 = num(metrics, 'total_rev_cagr_5y');
    const rev10 = num(metrics, 'total_rev_cagr_10y');
    const ebitda3 = num(metrics, 'ebitda_cagr_3y');
    const ebitda5 = num(metrics, 'ebitda_cagr_5y');
    const ebitda10 = num(metrics, 'ebitda_cagr_10y');
    const eps5 = num(metrics, 'eps_diluted_cagr_5y');
    const eps10 = num(metrics, 'eps_diluted_cagr_10y');
    const oper5 = num(metrics, 'oper_inc_cagr_5y');
    const niM = num(metrics, 'ni_margin');
    const niMAvg5 = num(metrics, 'ni_margin_avg_5y');
    const ebitdaM = num(metrics, 'ebitda_margin');
    const ebitdaMAvg5 = num(metrics, 'ebitda_margin_avg_5y');

    // Sectores inherentemente cíclicos — aplicar tolerancia mayor
    const cyclicalSectors = ['industry', 'util', 'consumer']; // semi-cíclicos en este conjunto
    const isCyclical = cyclicalSectors.includes(sectorKey);

    // Señal 1: Revenue CAGR 3y muy superior al 10y
    if (rev3 != null && rev10 != null && rev10 > 0) {
      const ratio = rev3 / rev10;
      if (ratio > 2 && rev3 > 15) {
        result.signals.push({
          severity: 'warn',
          label: 'Revenue en aceleración fuerte',
          detail: `Revenue CAGR 3y (${rev3.toFixed(1)}%) es ${ratio.toFixed(1)}x el 10y (${rev10.toFixed(1)}%). Puede ser pico de ciclo, adquisición reciente, o producto nuevo. Los analistas extrapolan el 3y — peligroso si es cíclico.`
        });
        result.detected = true;
      }
      if (ratio < 0.4 && rev10 > 3) {
        result.signals.push({
          severity: 'warn',
          label: 'Desaceleración estructural',
          detail: `Revenue CAGR 3y (${rev3.toFixed(1)}%) está muy por debajo del 10y (${rev10.toFixed(1)}%). Posible saturación del mercado, pérdida de cuota o disrupción.`
        });
        result.detected = true;
      }
    }

    // Señal 2: EBITDA CAGR 3y muy superior al 5y (margin expansion reciente)
    if (ebitda3 != null && ebitda5 != null && ebitda5 > 0) {
      const ratio = ebitda3 / ebitda5;
      if (ratio > 2.5 && ebitda3 > 20) {
        result.signals.push({
          severity: 'warn',
          label: 'EBITDA en pico temporal',
          detail: `EBITDA CAGR 3y (${ebitda3.toFixed(1)}%) supera al 5y (${ebitda5.toFixed(1)}%) en ${ratio.toFixed(1)}x. Margen posiblemente inflado por: precios elevados post-inflación, menores costes inputs, o ciclo favorable. No asumir sostenible.`
        });
        result.detected = true;
      }
    }

    // Señal 3: Margen actual muy superior a promedio 5y
    if (niM != null && niMAvg5 != null && niMAvg5 > 0) {
      const spread = niM - niMAvg5;
      if (spread > 3 && niM > niMAvg5 * 1.3) {
        result.signals.push({
          severity: 'warn',
          label: 'Margen neto sobre su media histórica',
          detail: `Net Margin actual (${niM.toFixed(1)}%) está ${spread.toFixed(1)}pp por encima de su media 5y (${niMAvg5.toFixed(1)}%). Reversión a la media reduciría beneficios ${(100 - (niMAvg5/niM)*100).toFixed(0)}%.`
        });
        result.detected = true;
      }
    }
    if (ebitdaM != null && ebitdaMAvg5 != null && ebitdaMAvg5 > 0) {
      const spread = ebitdaM - ebitdaMAvg5;
      if (spread > 4 && ebitdaM > ebitdaMAvg5 * 1.25) {
        result.signals.push({
          severity: 'info',
          label: 'EBITDA margin sobre su media',
          detail: `EBITDA margin ${ebitdaM.toFixed(1)}% vs media 5y ${ebitdaMAvg5.toFixed(1)}%. Pico de ciclo operativo.`
        });
        result.detected = true;
      }
    }

    // Señal 4: EPS 5y negativo mientras Revenue 5y positivo (compresión de márgenes histórica)
    if (eps5 != null && rev5 != null && eps5 < 0 && rev5 > 3) {
      result.signals.push({
        severity: 'warn',
        label: 'EPS histórico contradice Revenue',
        detail: `EPS CAGR 5y (${eps5.toFixed(1)}%) negativo mientras Revenue creció ${rev5.toFixed(1)}%/año. Compresión estructural de márgenes o dilución masiva. Desconfía del EPS proyectado.`
      });
      result.detected = true;
    }

    // Veredicto global
    if (result.signals.length >= 2) {
      result.verdict = isCyclical ? 'cyclical_peak_suspected' : 'peak_suspected';
      result.severity = 'warn';
    } else if (result.signals.length === 1) {
      result.verdict = 'monitor';
      result.severity = 'info';
    } else {
      result.verdict = 'no_cyclicality_signal';
    }

    return result;
  }

  // =
  // v2 #12 — SENSIBILIDAD DEL DCF
  // =
  // Recalcula el upside del DCF con shocks razonables en WACC y g.
  // Si el upside desaparece con WACC+1% y g-1%, el modelo no es robusto.
  function dcfSensitivity(metrics) {
    const result = { canRun: false, scenarios: [], robustness: null };

    const dcfUpside = num(metrics, 'dcf_fair_value_upside');
    const wacc = num(metrics, 'wacc');
    const fvUpside = num(metrics, 'fair_value_upside');
    const fvConf = getRaw(metrics, 'fair_value_confidence');

    // Si no hay DCF o WACC, no podemos ejecutar
    if (dcfUpside == null || wacc == null) {
      return result;
    }

    result.canRun = true;

    // Modelo Gordon simplificado (reversa) para estimar implied growth:
    // price = FCF * (1+g) / (r-g)  →  si upside dice "fair = price × (1+up/100)",
    // y asumimos g_terminal ≈ 2-3%, podemos aproximar sensibilidad usando elasticidad.
    //
    // Elasticidad aproximada del DCF respecto a r-g:
    // Un DCF con WACC=r y g=2% tiene el grueso del valor en el terminal (típicamente 70-80%).
    // Terminal value ∝ 1/(r-g). Derivada: dTV/TV = -1/(r-g) * d(r-g)
    //
    // Si r=10% y g=2%, entonces r-g=8%. Shock de WACC+1% y g-1% → r-g pasa a 10% → TV cae 20%.
    // Si TV es 75% del valor total, el upside cae ~15%.

    const rMinusG = Math.max(wacc - 2, 3); // asumiendo g terminal 2%
    const terminalWeight = 0.75; // típico

    // Escenario BASE (original)
    result.scenarios.push({
      label: 'Base (modelo original)',
      wacc: wacc,
      gAssumed: 2,
      upside: dcfUpside,
      verdict: dcfUpside > 15 ? 'COMPRA' : dcfUpside > 0 ? 'JUSTO' : 'SOBREVALORADO'
    });

    // Escenario ADVERSO: WACC +1%, g -1% → r-g sube 2 puntos
    const rMinusGAdverse = rMinusG + 2;
    const terminalMultiplier = rMinusG / rMinusGAdverse; // cae
    const adverseAdjust = (1 - terminalWeight) + terminalWeight * terminalMultiplier;
    // Valor nuevo = valor actual × adverseAdjust → upside se ajusta
    // precio_actual = fv_base / (1 + upside_base/100)
    // fv_adverso = fv_base × adverseAdjust
    // upside_adverso = fv_adverso / precio_actual - 1 = (1 + upside_base/100) × adverseAdjust - 1
    const fvRatio = 1 + dcfUpside / 100;
    const adverseRatio = fvRatio * adverseAdjust;
    const adverseUpside = (adverseRatio - 1) * 100;
    result.scenarios.push({
      label: 'Adverso (WACC+1%, g-1%)',
      wacc: wacc + 1,
      gAssumed: 1,
      upside: adverseUpside,
      verdict: adverseUpside > 15 ? 'COMPRA' : adverseUpside > 0 ? 'JUSTO' : 'SOBREVALORADO'
    });

    // Escenario FAVORABLE: WACC -1%, g +1% → r-g baja 2 puntos
    const rMinusGFav = Math.max(rMinusG - 2, 1);
    const terminalMultFav = rMinusG / rMinusGFav;
    const favAdjust = (1 - terminalWeight) + terminalWeight * terminalMultFav;
    const favRatio = fvRatio * favAdjust;
    const favUpside = (favRatio - 1) * 100;
    result.scenarios.push({
      label: 'Favorable (WACC-1%, g+1%)',
      wacc: wacc - 1,
      gAssumed: 3,
      upside: favUpside,
      verdict: favUpside > 15 ? 'COMPRA' : favUpside > 0 ? 'JUSTO' : 'SOBREVALORADO'
    });

    // Evaluar robustez
    const baseBuy = dcfUpside > 15;
    const adverseBuy = adverseUpside > 15;
    const adverseJusto = adverseUpside > 0;
    if (baseBuy && adverseBuy) {
      result.robustness = { label: 'ROBUSTA', color: '#22d45a',
        msg: 'El DCF mantiene upside >15% incluso con asunciones adversas. Tesis con margen de seguridad real.' };
    } else if (baseBuy && adverseJusto) {
      result.robustness = { label: 'MODERADA', color: '#f0b429',
        msg: 'El DCF aguanta sin upside significativo en escenario adverso. Margen de seguridad existe pero no es amplio.' };
    } else if (baseBuy) {
      result.robustness = { label: 'FRÁGIL', color: '#f0835a',
        msg: 'El upside del DCF desaparece y se vuelve negativo con WACC+1% y g-1%. Sensible a asunciones — no confiar al 100%.' };
    } else {
      result.robustness = { label: 'NO COMPRA', color: '#f0483a',
        msg: 'El DCF base no muestra upside de compra (>15%). Los escenarios son para referencia.' };
    }

    // Advertencia adicional si confianza es LOW
    if (fvConf === 'LOW') {
      result.robustness.msg += ' ⚠️ Además la confianza del modelo es LOW — los números inputs tienen alta incertidumbre.';
    }

    return result;
  }

  // =
  // v2 #13 — AJUSTES IFRS / MERCADO EUROPEO
  // =
  // Detecta empresa europea y aplica ajustes:
  // - SOCIMIs se tratan como REIT con umbrales EU
  // - Dual-class alertada (común en FR, NL, SE)
  // - Net debt/EBITDA europeo suele ser +0.5x más permisivo
  function detectEuropeanContext(metrics) {
    const result = { isEuropean: false, country: null, exchange: null,
                     specialClass: null, adjustmentsApplied: [], notes: [] };

    const ticker = getRaw(metrics, 'ticker') || getRaw(metrics, 'Ticker') || '';
    const country = (getRaw(metrics, 'country') || getRaw(metrics, 'Country') || '').toLowerCase();
    const exchange = (getRaw(metrics, 'exchange') || getRaw(metrics, 'primary_exchange') || '').toLowerCase();
    const name = (getRaw(metrics, 'name') || '').toLowerCase();
    const sector = (getRaw(metrics, 'sector') || '').toLowerCase();

    // Sufijos europeos en ticker
    const euSuffixes = [
      { suf: /\.(mc|ma)$/i, country: 'Spain' },
      { suf: /\.pa$/i, country: 'France' },
      { suf: /\.(de|f|xe|be|mu|sg|du|ha|hm|mi)$/i, country: 'Germany' },
      { suf: /\.(mi|ti)$/i, country: 'Italy' },
      { suf: /\.(as|am)$/i, country: 'Netherlands' },
      { suf: /\.(l|lon)$/i, country: 'United Kingdom' },
      { suf: /\.(br|bru)$/i, country: 'Belgium' },
      { suf: /\.(sw|vx|vy)$/i, country: 'Switzerland' },
      { suf: /\.(vi|vie)$/i, country: 'Austria' },
      { suf: /\.(lis|ls|el)$/i, country: 'Portugal' },
      { suf: /\.(co|cph)$/i, country: 'Denmark' },
      { suf: /\.(st|sto)$/i, country: 'Sweden' },
      { suf: /\.(ol|osl)$/i, country: 'Norway' },
      { suf: /\.(he|hel)$/i, country: 'Finland' },
      { suf: /\.(ir|is)$/i, country: 'Ireland' },
      { suf: /\.(at|ath)$/i, country: 'Greece' },
    ];

    for (const { suf, country: c } of euSuffixes) {
      if (suf.test(ticker)) {
        result.isEuropean = true;
        result.country = c;
        break;
      }
    }

    // Check por texto si no hay sufijo
    if (!result.isEuropean) {
      const euCountries = ['spain','france','germany','italy','netherlands','united kingdom',
                          'uk','belgium','switzerland','austria','portugal','denmark',
                          'sweden','norway','finland','ireland','greece','luxembourg','spain'];
      for (const c of euCountries) {
        if (country.includes(c)) {
          result.isEuropean = true;
          result.country = c.charAt(0).toUpperCase() + c.slice(1);
          break;
        }
      }
    }

    if (!result.isEuropean) return result;

    // SOCIMI (REIT español)
    if (name.includes('socimi') || (result.country === 'Spain' && /real estate|inmobil|inmoviliar/.test(sector))) {
      result.specialClass = 'SOCIMI';
      result.notes.push(`Clasificada como SOCIMI (REIT español). Obligación legal de distribuir ≥80% de beneficios por alquileres, 50% por venta de activos, 100% de dividendos de filiales. Usar métricas FFO/AFFO en lugar de Net Income.`);
    }

    // Alertas sobre dual-class shares (frecuentes en NL, FR, SE, DK)
    const dualClassCountries = ['France', 'Netherlands', 'Sweden', 'Denmark', 'Finland', 'Norway'];
    if (dualClassCountries.includes(result.country)) {
      result.notes.push(`${result.country} permite estructuras dual-class frecuentes (acciones tipo A/B, loyalty voting shares). Verifica si la empresa tiene voting rights desproporcionados — common stock puede tener menos poder del que parece.`);
    }

    // Ajustes de tolerancia en umbrales
    result.adjustmentsApplied.push({
      item: 'Net Debt/EBITDA',
      reason: 'Empresas europeas operan típicamente con apalancamiento +0.5x superior a US sin ser percibidas como de mayor riesgo (cultura bancaria vs bonds).',
      impact: 'Tolerancia +0.5x sobre umbral sectorial'
    });

    result.adjustmentsApplied.push({
      item: 'Dividend payout',
      reason: 'Cultura europea de dividendo: payouts 50-70% son normales (vs 30-40% US). Presión por dividendo afecta la reinversión.',
      impact: 'No penalizar payouts hasta 70% si FCF cubre'
    });

    if (result.country === 'Germany' || result.country === 'France') {
      result.notes.push(`${result.country}: ojo con el "impuesto patrimonial" y la retención fiscal a no residentes sobre dividendos (25-30%). El yield neto para inversor español es inferior al bruto reportado.`);
    }

    if (result.country === 'United Kingdom') {
      result.notes.push(`Reino Unido reporta en GBP pero Bloomberg/proveedores frecuentemente convierten a USD sin avisar. Verifica la moneda de cada métrica — discrepancias de FX pueden distorsionar el análisis.`);
    }

    if (result.country === 'Switzerland') {
      result.notes.push(`Suiza: retención de 35% sobre dividendos (recuperable 20% con convenio). CHF suele apreciar en crisis — afecta retorno total del inversor europeo.`);
    }

    return result;
  }

  // =
  // v2 #14 — ANÁLISIS TEMPORAL (DETERIORO RECIENTE)
  // =
  // El sistema actual toma CAGR 5y/10y como señal positiva. Pero si el
  // último trimestre está deteriorándose, el CAGR histórico oculta el problema.
  function runTemporalAnalysis(metrics) {
    const alerts = [];
    const signals = [];

    // LTM vs CAGR 5y en varias métricas
    const revLTM = num(metrics, 'total_rev_growth');  // growth YoY último periodo
    const rev5 = num(metrics, 'total_rev_cagr_5y');
    const epsLTM = num(metrics, 'eps_diluted_growth');
    const eps5 = num(metrics, 'eps_diluted_cagr_5y');
    const ebitdaLTM = num(metrics, 'ebitda_growth');
    const ebitda5 = num(metrics, 'ebitda_cagr_5y');
    const fcfLTM = num(metrics, 'fcf_levered_growth');
    const fcf5 = num(metrics, 'fcf_levered_cagr_5y');

    // Comparador genérico
    function compareLTMvsCAGR(label, ltm, cagr, alertThreshold = 10) {
      if (ltm == null || cagr == null) return null;
      const gap = cagr - ltm;  // positivo → ltm peor que cagr (deterioro)
      if (gap > alertThreshold && cagr > 0) {
        signals.push({
          severity: 'warn',
          label: `${label} desacelerando`,
          detail: `${label} últimos 12 meses: ${ltm.toFixed(1)}% vs CAGR 5y: ${cagr.toFixed(1)}%. Gap ${gap.toFixed(1)}pp — crecimiento se ha frenado respecto a la tendencia histórica.`,
          gap
        });
      }
      if (ltm < 0 && cagr > 5) {
        signals.push({
          severity: 'warn',
          label: `${label} negativo tras histórico positivo`,
          detail: `${label} LTM ${ltm.toFixed(1)}% es NEGATIVO, cuando el CAGR 5y era ${cagr.toFixed(1)}%. Inflexión reciente — investigar causa antes de invertir.`,
          gap
        });
      }
      // Caso positivo: mejora reciente
      if (ltm - cagr > 15 && cagr > 0) {
        signals.push({
          severity: 'info',
          label: `${label} acelerando`,
          detail: `${label} LTM ${ltm.toFixed(1)}% supera al CAGR 5y (${cagr.toFixed(1)}%). Mejora reciente — verifica sostenibilidad.`,
          gap: -Math.abs(ltm - cagr)
        });
      }
      return gap;
    }

    compareLTMvsCAGR('Revenue', revLTM, rev5, 8);
    compareLTMvsCAGR('EPS', epsLTM, eps5, 15);
    compareLTMvsCAGR('EBITDA', ebitdaLTM, ebitda5, 10);
    compareLTMvsCAGR('FCF', fcfLTM, fcf5, 15);

    // Revisión de analistas 30d vs 90d (si bajaron recientemente)
    const posRev30 = num(metrics, 'analyst_pos_eps_revisions_ratio_30d');
    const posRev90 = num(metrics, 'analyst_pos_eps_revisions_ratio_90d');
    if (posRev30 != null && posRev90 != null && posRev30 < posRev90 - 15) {
      signals.push({
        severity: 'warn',
        label: 'Revisiones de analistas empeorando',
        detail: `Revisiones positivas 30d (${posRev30.toFixed(0)}%) por debajo de 90d (${posRev90.toFixed(0)}%). Los analistas están bajando expectativas en el último mes.`
      });
    }

    // Precio vs MA50 y MA200 divergentes
    const pct50 = num(metrics, 'price_to_ma50') || num(metrics, 'price_pct_ma50');
    const pct200 = num(metrics, 'price_to_ma200') || num(metrics, 'price_pct_ma200');
    if (pct50 != null && pct200 != null) {
      if (pct50 < 95 && pct200 > 100) {
        signals.push({
          severity: 'info',
          label: 'Ruptura bajista de corto plazo',
          detail: `Precio vs MA50 (${pct50.toFixed(0)}%) por debajo del 95% mientras MA200 (${pct200.toFixed(0)}%) sigue arriba. Tendencia larga alcista pero corto plazo girando.`
        });
      }
    }

    const warnCount = signals.filter(s => s.severity === 'warn').length;
    const verdict = warnCount >= 2 ? 'deterioro' : warnCount === 1 ? 'monitorizar' : 'sin_deterioro';

    return { signals, verdict, warnCount };
  }

  // =
  // v1 #6 — STRESS TEST
  // =
  function runStressTest(metrics) {
    const ebitdaM = num(metrics, 'ebitda_margin');
    const ic = num(metrics, 'interest_coverage');
    const ndEbitda = num(metrics, 'net_debt_to_ebitda');
    const fcfM = num(metrics, 'fcf_margin');

    const result = { canRun: false, survives: null, details: [], verdict: 'unknown' };

    if (ebitdaM != null && ic != null && ndEbitda != null) {
      result.canRun = true;
      const ebitdaStress = 0.49;
      const icStress = ic * ebitdaStress;
      const ndEbitdaStress = ndEbitda / ebitdaStress;
      result.details.push({
        label: 'Interest Coverage stress',
        value: icStress.toFixed(1) + 'x',
        pass: icStress > 1.5,
        comment: icStress < 1 ? 'No cubre intereses — default probable'
               : icStress < 1.5 ? 'Cobertura crítica'
               : icStress < 2.5 ? 'Cobertura justa — aguanta con presión'
               : 'Cobertura sólida'
      });
      result.details.push({
        label: 'Net Debt/EBITDA stress',
        value: ndEbitdaStress.toFixed(1) + 'x',
        pass: ndEbitdaStress < 6,
        comment: ndEbitdaStress > 8 ? 'Insostenible — violación covenants'
               : ndEbitdaStress > 6 ? 'Zona peligrosa'
               : ndEbitdaStress > 4 ? 'Manejable pero alto'
               : 'Saludable incluso en stress'
      });
      const passes = result.details.filter(d => d.pass).length;
      result.survives = passes === result.details.length;
      result.verdict = passes === result.details.length ? 'robust'
                     : passes >= 1 ? 'fragile' : 'distressed';
    } else if (fcfM != null) {
      result.canRun = true;
      const fcfMStress = fcfM - 8;
      result.details.push({
        label: 'FCF Margin stress',
        value: fcfMStress.toFixed(1) + '%',
        pass: fcfMStress > 0,
        comment: fcfMStress < -5 ? 'FCF muy negativo'
               : fcfMStress < 0 ? 'FCF ligeramente negativo'
               : fcfMStress < 5 ? 'FCF positivo pero ajustado'
               : 'FCF robusto'
      });
      result.survives = fcfMStress > 0;
      result.verdict = fcfMStress > 3 ? 'robust' : fcfMStress > 0 ? 'fragile' : 'distressed';
    }
    return result;
  }

  // =
  // v1 #7 — CONVICCIÓN
  // =
  function computeConviction(R) {
    const m = R.modules;
    const scores = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm9']
      .filter(k => m[k]).map(k => m[k].score);
    if (m.m8 && !m.m8.noDividend) scores.push(m.m8.score);

    const strong = scores.filter(s => s >= 0.70).length;
    const borderline = scores.filter(s => s >= 0.55 && s < 0.70).length;
    const weak = scores.filter(s => s < 0.55).length;
    const total = scores.length;

    const convictionPct = Math.round(((strong * 1.0 + borderline * 0.5 - weak * 0.3) / total) * 100);
    const conviction = Math.max(0, Math.min(100, convictionPct));

    let label, color;
    if (conviction >= 75 && strong >= total * 0.6) { label = 'ALTA'; color = '#22d45a'; }
    else if (conviction >= 50) { label = 'MEDIA'; color = '#f0b429'; }
    else if (conviction >= 25) { label = 'BAJA'; color = '#f0835a'; }
    else { label = 'MUY BAJA'; color = '#f0483a'; }

    return { conviction, label, color, strong, borderline, weak, total };
  }

  // =
  // v1 #1+#3 — VEREDICTO CONDICIONAL
  // =
  function conditionalVerdict(R, profileId) {
    const m = R.modules;
    const ps = R.profileScores[profileId];
    if (!ps) return null;
    const pct = ps.quantScore;

    const conditions = {
      scoreHigh: pct >= 70,
      profitabilityOk: m.m1.score >= 0.60,
      qualityOk: m.m3.score >= 0.60,
      riskOk: m.m4.score >= 0.55,
      valuationOk: m.m6.score >= 0.50 || m.m7.score >= 0.55,
      noVeto: R.m0.passes,
      fvConfidenceOk: R.meta.fvConf !== 'LOW',
    };

    const strictProfiles = ['value', 'quality', 'deepvalue', 'dgi', 'defensive'];
    if (strictProfiles.includes(profileId)) {
      conditions.profitabilityOk = m.m1.score >= 0.65;
      conditions.qualityOk = m.m3.score >= 0.65;
    }
    if (['growth', 'smallcap'].includes(profileId)) {
      conditions.growthOk = m.m2.score >= 0.60;
    }

    // v2: Incorporar señales de deterioro temporal y ciclicidad
    if (R.analystUpgrades?.temporal?.verdict === 'deterioro') {
      conditions.noRecentDeterioration = false;
    } else {
      conditions.noRecentDeterioration = true;
    }
    if (R.analystUpgrades?.cyclicality?.verdict === 'peak_suspected' ||
        R.analystUpgrades?.cyclicality?.verdict === 'cyclical_peak_suspected') {
      conditions.notAtPeak = false;
    } else {
      conditions.notAtPeak = true;
    }

    const failed = Object.entries(conditions).filter(([_, v]) => !v).map(([k]) => k);

    let verdict, reason;
    if (!R.m0.passes) {
      verdict = 'NO COMPRAR';
      reason = 'Veto absoluto M0 activo — riesgo de pérdida permanente de capital';
    } else if (pct < 50) {
      verdict = 'NO COMPRAR';
      reason = `Score ${pct}% insuficiente. Fundamentales débiles.`;
    } else if (pct >= 70 && failed.length === 0) {
      verdict = 'COMPRAR';
      reason = `Score ${pct}% + todos los filtros superados (incl. no deterioro reciente y no en pico).`;
    } else if (pct >= 70) {
      verdict = 'WATCHLIST';
      const failedLabels = failed.map(labelFailure).join(', ');
      reason = `Score ${pct}% alcanzado pero con debilidades: ${failedLabels}.`;
    } else {
      verdict = 'WATCHLIST';
      reason = `Score ${pct}% — fundamentales aceptables pero no sobresalientes.`;
    }

    return { verdict, reason, conditions, failed };
  }

  function labelFailure(key) {
    return {
      scoreHigh: 'score <70%',
      profitabilityOk: 'rentabilidad débil (M1)',
      qualityOk: 'calidad financiera débil (M3)',
      riskOk: 'riesgo/deuda elevado (M4)',
      valuationOk: 'sin soporte de valoración',
      growthOk: 'crecimiento insuficiente (M2)',
      noVeto: 'veto M0 activo',
      fvConfidenceOk: 'FV Confidence LOW',
      noRecentDeterioration: 'deterioro reciente detectado',
      notAtPeak: 'posible pico de ciclo',
    }[key] || key;
  }

  // =
  // v1 #5 — CHECKLIST "NO SÉ" NEUTRAL
  // =
  window.scoreChecklist = function (answers) {
    const sectionScores = {};
    const CHECKLIST = window.CHECKLIST;
    if (!CHECKLIST) return {};

    for (const [sectionId, section] of Object.entries(CHECKLIST)) {
      let totalWeight = 0, weightedSum = 0, answeredCount = 0;
      section.questions.forEach(q => {
        const ans = answers[q.id];
        if (ans === 'yes') { weightedSum += 2; totalWeight += 2; answeredCount++; }
        else if (ans === 'no') { weightedSum += -2; totalWeight += 2; answeredCount++; }
      });
      const normalized = totalWeight > 0 ? (weightedSum / totalWeight + 1) / 2 : 0.5;
      sectionScores[sectionId] = {
        score: Math.max(0, Math.min(1, normalized)),
        coverage: section.questions.length > 0 ? answeredCount / section.questions.length : 0,
      };
    }

    const CHECKLIST_WEIGHTS = window.CHECKLIST_WEIGHTS;
    const profileQualScores = {};
    if (CHECKLIST_WEIGHTS) {
      for (const [profileId, weights] of Object.entries(CHECKLIST_WEIGHTS)) {
        const [w1, w2, w3, w4, w5, w6, w7, w8] = weights;
        const total = w1 + w2 + w3 + w4 + w5 + w6 + w7 + w8;
        const weighted =
          (sectionScores.s1?.score || 0.5) * w1 + (sectionScores.s2?.score || 0.5) * w2 +
          (sectionScores.s3?.score || 0.5) * w3 + (sectionScores.s4?.score || 0.5) * w4 +
          (sectionScores.s5?.score || 0.5) * w5 + (sectionScores.s6?.score || 0.5) * w6 +
          (sectionScores.s7?.score || 0.5) * w7 + (sectionScores.s8?.score || 0.5) * w8;
        profileQualScores[profileId] = weighted / total;
      }
    }

    const QUAL_VETOS = window.QUAL_VETOS || [];
    const qualVetosFired = QUAL_VETOS.filter(veto => {
      const allQs = Object.values(CHECKLIST).flatMap(s => s.questions);
      const theQ = allQs.find(q2 => {
        const qNum = parseInt(q2.id.replace(/[a-z]/gi, ''));
        return veto.q === qNum || q2.id === `s${veto.section}q${veto.q}`;
      });
      return theQ && answers[theQ.id] === 'no';
    });

    const simpleSectionScores = {};
    Object.entries(sectionScores).forEach(([k, v]) => { simpleSectionScores[k] = v.score; });

    return {
      sectionScores: simpleSectionScores,
      sectionCoverage: Object.fromEntries(Object.entries(sectionScores).map(([k, v]) => [k, v.coverage])),
      profileQualScores,
      qualVetosFired,
    };
  };

  // =
  // v1 #8 — SECTOR GENERAL
  // =
  function sectorFallbackWarning(R) {
    if (R.sectorKey === 'general') {
      return { severity: 'warn',
        msg: `⚠️ Sector clasificado como "general" (fallback). Los umbrales son promedios sin ajuste. Clasifica manualmente para análisis fiable.` };
    }
    return null;
  }

  // =
  // WRAPPER de runFullAnalysis
  // =
  const _origRunFullAnalysis = window.runFullAnalysis;
  window.runFullAnalysis = function (metrics, sectorData) {
    const R = _origRunFullAnalysis(metrics, sectorData);

    R.analystUpgrades = {
      // v1
      dataSanity: runDataSanity(metrics),
      stressTest: runStressTest(metrics),
      conviction: computeConviction(R),
      sectorFallback: sectorFallbackWarning(R),
      // v2
      crossValidation: runCrossValidation(metrics),
      cyclicality: detectCyclicality(metrics, R.sectorKey),
      dcfSensitivity: dcfSensitivity(metrics),
      europeanContext: detectEuropeanContext(metrics),
      temporal: runTemporalAnalysis(metrics),
      conditionalVerdicts: {},
    };

    Object.keys(R.profileScores).forEach(profileId => {
      const cv = conditionalVerdict(R, profileId);
      R.analystUpgrades.conditionalVerdicts[profileId] = cv;
      if (cv) {
        R.profileScores[profileId].verdict = cv.verdict;
        R.profileScores[profileId].verdictReason = cv.reason;
        R.profileScores[profileId].verdictColor =
          cv.verdict === 'COMPRAR' ? '#22d45a' :
          cv.verdict === 'WATCHLIST' ? '#f0b429' : '#f0483a';
      }
    });

    console.log('[AnalystUpgrades v2] Análisis extendido ✓', R.analystUpgrades);

    setTimeout(() => tryRenderAnalystPanel(R), 100);
    setTimeout(() => tryRenderAnalystPanel(R), 500);
    setTimeout(() => tryRenderAnalystPanel(R), 1500);

    // Activar devil's advocate una vez el análisis está hecho
    setTimeout(() => setupDevilsAdvocate(), 2000);

    return R;
  };

  // =
  // v2 #9 — DEVIL'S ADVOCATE SOBRE EL CHECKLIST
  // =
  // Cuando el usuario responde "Sí" a una pregunta crítica, abre un prompt
  // discreto pidiendo justificación breve. Combate el sesgo de confirmación.
  let devilsAdvocateSetup = false;
  function setupDevilsAdvocate() {
    if (devilsAdvocateSetup) return;
    if (!window.CHECKLIST) return;

    // Interceptar la función answerQ original
    const origAnswerQ = window.answerQ;
    if (typeof origAnswerQ !== 'function') return;

    window.answerQ = function (qId, answer, btn) {
      // Ejecutar comportamiento original
      origAnswerQ.apply(this, arguments);

      // Si responde "sí" a pregunta crítica, pedir justificación
      if (answer !== 'yes') {
        // Limpiar justificación previa si cambió de respuesta
        const justifBox = document.getElementById(`devils_${qId}`);
        if (justifBox) justifBox.remove();
        return;
      }

      // Buscar la pregunta en el checklist para saber si es crítica
      const allQs = Object.values(window.CHECKLIST).flatMap(s => s.questions);
      const theQ = allQs.find(q => q.id === qId);
      if (!theQ || !theQ.critical) return;

      // Mostrar caja de justificación
      const qbox = document.getElementById(`qbox_${qId}`);
      if (!qbox) return;

      const existing = document.getElementById(`devils_${qId}`);
      if (existing) return; // ya existe

      const devilsBox = document.createElement('div');
      devilsBox.id = `devils_${qId}`;
      devilsBox.style.cssText = `
        margin-top: 8px;
        padding: 10px 12px;
        background: rgba(88,166,255,0.06);
        border-left: 3px solid #58a6ff;
        border-radius: 6px;
        font-size: .78rem;
        color: #c9d1d9;
      `;
      devilsBox.innerHTML = `
        <div style="font-weight:700;margin-bottom:6px;color:#58a6ff">
          😈 Devil's Advocate — Pregunta crítica
        </div>
        <div style="margin-bottom:8px;font-size:.74rem;color:#8b949e;line-height:1.5">
          Has respondido "Sí" a una pregunta crítica. Escribe en 1-2 líneas la evidencia concreta que respalda tu respuesta (informe anual, cifra, fuente). Si no puedes justificarlo, considera cambiar la respuesta a "No sé".
        </div>
        <textarea
          id="devilsJustif_${qId}"
          placeholder="Ej: En el informe anual 2024 se menciona que el 78% de ingresos son contratos plurianuales (pág. 34)"
          style="width:100%;min-height:50px;padding:6px 8px;background:rgba(0,0,0,0.25);
                 border:1px solid #30363d;border-radius:4px;color:#c9d1d9;
                 font-family:inherit;font-size:.76rem;resize:vertical;"
        ></textarea>
        <div style="margin-top:6px;display:flex;gap:8px;align-items:center;font-size:.7rem">
          <span id="devilsStatus_${qId}" style="color:#8b949e">Sin justificar</span>
          <button onclick="window.__saveDevilsJustif('${qId}')" style="
            padding:4px 10px;background:#58a6ff;color:#fff;border:none;
            border-radius:4px;cursor:pointer;font-size:.7rem;font-weight:600;
          ">✓ Guardar</button>
          <button onclick="window.__clearDevilsJustif('${qId}')" style="
            padding:4px 10px;background:transparent;color:#8b949e;
            border:1px solid #30363d;border-radius:4px;cursor:pointer;
            font-size:.7rem;
          ">Omitir</button>
        </div>
      `;
      qbox.appendChild(devilsBox);
    };

    // Guardar las justificaciones en un almacén global
    window.__devilsJustifications = window.__devilsJustifications || {};

    window.__saveDevilsJustif = function (qId) {
      const ta = document.getElementById(`devilsJustif_${qId}`);
      const status = document.getElementById(`devilsStatus_${qId}`);
      if (!ta) return;
      const txt = ta.value.trim();
      if (txt.length < 15) {
        status.textContent = '⚠️ Justificación demasiado corta (<15 caracteres)';
        status.style.color = '#f0b429';
        return;
      }
      window.__devilsJustifications[qId] = txt;
      status.textContent = '✓ Justificación guardada';
      status.style.color = '#22d45a';
    };

    window.__clearDevilsJustif = function (qId) {
      delete window.__devilsJustifications[qId];
      const box = document.getElementById(`devils_${qId}`);
      if (box) box.remove();
    };

    devilsAdvocateSetup = true;
    console.log('[AnalystUpgrades v2] Devil\'s Advocate activado sobre preguntas críticas');
  }

  // Re-engancha renderResults por si se llama manualmente
  if (typeof window.renderResults === 'function') {
    const _origRenderResults = window.renderResults;
    window.renderResults = function () {
      _origRenderResults.apply(this, arguments);
      if (window.analysisResult) {
        setTimeout(() => tryRenderAnalystPanel(window.analysisResult), 100);
      }
    };
  }

  // =
  // RENDER DEL PANEL
  // =
  function tryRenderAnalystPanel(R) {
    if (!R || !R.analystUpgrades) return;
    const existing = document.getElementById('analystDiagnosticPanel');
    if (existing) existing.remove();

    const tabReasoning = document.getElementById('tab-reasoning');
    const panel = document.createElement('div');
    panel.id = 'analystDiagnosticPanel';
    panel.style.cssText = `
      max-width: 1280px;
      margin: 40px auto 80px;
      padding: 0 48px;
      font-family: system-ui, -apple-system, sans-serif;
      color: #c9d1d9;
      position: relative;
      z-index: 1;
      display: block !important;
    `;
    panel.innerHTML = buildPanelHTML(R);

    if (tabReasoning) {
      tabReasoning.insertAdjacentElement('afterend', panel);
    } else {
      document.body.appendChild(panel);
    }
    console.log('[AnalystUpgrades v2] Panel renderizado ✓');
  }

  function buildPanelHTML(R) {
    const U = R.analystUpgrades;
    return `
      <style>
        #analystDiagnosticPanel *{box-sizing:border-box}
        #analystDiagnosticPanel .ap-head{
          display:flex;align-items:center;gap:12px;margin-bottom:16px;padding:16px 20px;
          background:linear-gradient(135deg,rgba(88,166,255,0.08),rgba(88,166,255,0.02));
          border:1px solid rgba(88,166,255,0.3);border-radius:12px;
        }
        #analystDiagnosticPanel .ap-sub{font-size:.72rem;color:#8b949e;letter-spacing:1px;text-transform:uppercase;font-weight:700}
        #analystDiagnosticPanel .ap-title{font-size:1.2rem;font-weight:800;color:#c9d1d9;letter-spacing:-.3px;margin-top:2px}
        #analystDiagnosticPanel .ap-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-bottom:18px}
        #analystDiagnosticPanel .ap-card{
          background:rgba(255,255,255,0.03);border:1px solid #30363d;border-radius:10px;
          padding:14px 16px;border-left:3px solid #58a6ff;
        }
        #analystDiagnosticPanel .ap-card.ok{border-left-color:#22d45a}
        #analystDiagnosticPanel .ap-card.warn{border-left-color:#f0b429}
        #analystDiagnosticPanel .ap-card.bad{border-left-color:#f0483a}
        #analystDiagnosticPanel .ap-card h4{margin:0 0 6px;font-size:.82rem;font-weight:700;color:#c9d1d9}
        #analystDiagnosticPanel .ap-val{
          font-family:ui-monospace,SFMono-Regular,monospace;font-size:1.3rem;font-weight:700;
          margin:6px 0 4px;color:#c9d1d9;
        }
        #analystDiagnosticPanel .ap-lbl{font-size:.72rem;color:#8b949e;line-height:1.5}
        #analystDiagnosticPanel .ap-alert{padding:10px 14px;border-radius:8px;margin-bottom:8px;font-size:.82rem;line-height:1.55;color:#8b949e}
        #analystDiagnosticPanel .ap-alert.warn{background:rgba(240,180,41,0.08);border-left:3px solid #f0b429}
        #analystDiagnosticPanel .ap-alert.info{background:rgba(88,166,255,0.06);border-left:3px solid #58a6ff}
        #analystDiagnosticPanel .ap-alert.bad{background:rgba(240,72,58,0.08);border-left:3px solid #f0483a}
        #analystDiagnosticPanel .ap-alert strong{color:#c9d1d9;font-weight:700}
        #analystDiagnosticPanel .ap-section{margin-bottom:24px}
        #analystDiagnosticPanel .ap-section-title{
          font-size:.92rem;font-weight:700;color:#c9d1d9;margin:0 0 10px;
          display:flex;align-items:center;gap:8px;padding-bottom:6px;
          border-bottom:1px solid rgba(255,255,255,0.05);
        }
        #analystDiagnosticPanel .ap-stress-row{
          display:flex;align-items:center;justify-content:space-between;gap:12px;
          padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.04);font-size:.8rem;
        }
        #analystDiagnosticPanel .ap-stress-row:last-child{border-bottom:none}
        #analystDiagnosticPanel .ap-stress-lbl{color:#8b949e;flex:1}
        #analystDiagnosticPanel .ap-stress-val{
          font-family:ui-monospace,SFMono-Regular,monospace;font-weight:700;padding:2px 8px;border-radius:4px;
        }
        #analystDiagnosticPanel .ap-stress-val.ok{background:rgba(34,212,90,0.15);color:#22d45a}
        #analystDiagnosticPanel .ap-stress-val.bad{background:rgba(240,72,58,0.15);color:#f0483a}
        #analystDiagnosticPanel .ap-stress-comment{font-size:.72rem;color:#6e7681;margin-top:2px;padding:0 12px 6px}
        #analystDiagnosticPanel .ap-conviction-bar{height:8px;border-radius:4px;background:rgba(255,255,255,0.06);overflow:hidden;margin:8px 0 4px}
        #analystDiagnosticPanel .ap-conviction-fill{height:100%;transition:width .6s}
        #analystDiagnosticPanel .ap-scenario-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:10px}
        #analystDiagnosticPanel .ap-scenario{padding:12px;border-radius:8px;background:rgba(255,255,255,0.03);border:1px solid #30363d}
        #analystDiagnosticPanel .ap-scenario h5{margin:0 0 6px;font-size:.72rem;color:#8b949e;text-transform:uppercase;letter-spacing:.5px}
        #analystDiagnosticPanel .ap-scenario .v{font-family:ui-monospace,monospace;font-size:1.1rem;font-weight:700}
        #analystDiagnosticPanel .ap-mini-tag{
          display:inline-block;padding:2px 6px;border-radius:3px;font-size:.65rem;
          font-weight:700;letter-spacing:.5px;margin-left:6px;
        }
        @media (max-width: 700px) {
          #analystDiagnosticPanel .ap-scenario-grid{grid-template-columns:1fr}
        }
      </style>

      <div class="ap-head">
        <div style="font-size:2rem;line-height:1">🔬</div>
        <div>
          <div class="ap-sub">Diagnóstico del Analista · v2.0 Profesional</div>
          <div class="ap-title">14 capas de validación y análisis avanzado</div>
        </div>
      </div>

      ${renderSectorFallback(U)}
      ${renderEuropeanContext(U)}
      ${renderConvictionCard(U)}
      ${renderDataSanitySection(U)}
      ${renderCrossValidationSection(U)}
      ${renderTemporalSection(U)}
      ${renderCyclicalitySection(U)}
      ${renderDCFSensitivitySection(U)}
      ${renderStressTestSection(U)}
      ${renderVerdictConditionsSection(R)}
      ${renderDevilsSummary()}
    `;
  }

  function renderSectorFallback(U) {
    if (!U.sectorFallback) return '';
    return `<div class="ap-alert warn">${U.sectorFallback.msg}</div>`;
  }

  function renderEuropeanContext(U) {
    const e = U.europeanContext;
    if (!e || !e.isEuropean) return '';
    const adj = e.adjustmentsApplied.map(a => `
      <div class="ap-stress-row">
        <span class="ap-stress-lbl"><strong style="color:#c9d1d9">${a.item}</strong>: ${a.reason}</span>
        <span class="ap-stress-val ok">${a.impact}</span>
      </div>`).join('');
    const notes = e.notes.map(n => `<div class="ap-alert info">${n}</div>`).join('');
    return `
      <div class="ap-section">
        <div class="ap-section-title">🇪🇺 Contexto Europeo — ${e.country}${e.specialClass ? ' · ' + e.specialClass : ''}</div>
        ${notes}
        ${adj ? `<div class="ap-card"><h4>Ajustes metodológicos aplicados</h4>${adj}</div>` : ''}
      </div>`;
  }

  function renderConvictionCard(U) {
    const c = U.conviction;
    if (!c) return '';
    return `
      <div class="ap-section">
        <div class="ap-section-title">📊 Convicción del Veredicto</div>
        <div class="ap-grid">
          <div class="ap-card" style="border-left-color:${c.color}">
            <h4>Índice de Convicción</h4>
            <div class="ap-val" style="color:${c.color}">${c.label} · ${c.conviction}%</div>
            <div class="ap-conviction-bar"><div class="ap-conviction-fill" style="width:${c.conviction}%;background:${c.color}"></div></div>
            <div class="ap-lbl">Mide cuántos módulos están sólidos vs raspando el umbral.</div>
          </div>
          <div class="ap-card ok"><h4>✅ Módulos sólidos</h4>
            <div class="ap-val" style="color:#22d45a">${c.strong} / ${c.total}</div>
            <div class="ap-lbl">≥ 70% — fortaleza genuina</div></div>
          <div class="ap-card warn"><h4>⚠️ Módulos raspando</h4>
            <div class="ap-val" style="color:#f0b429">${c.borderline} / ${c.total}</div>
            <div class="ap-lbl">55-70% — cumplen sin margen</div></div>
          <div class="ap-card bad"><h4>❌ Módulos débiles</h4>
            <div class="ap-val" style="color:#f0483a">${c.weak} / ${c.total}</div>
            <div class="ap-lbl">&lt; 55% — investigar</div></div>
        </div>
      </div>`;
  }

  function renderDataSanitySection(U) {
    const alerts = U.dataSanity || [];
    if (alerts.length === 0) {
      return `<div class="ap-section"><div class="ap-section-title">🔍 Validación de Métricas Input</div>
        <div class="ap-alert info">Sin outliers evidentes en las métricas.</div></div>`;
    }
    const html = alerts.map(a => `
      <div class="ap-alert ${a.severity === 'warn' ? 'warn' : 'info'}">
        <strong>${a.metric}${a.value != null ? ': ' + (typeof a.value === 'number' ? a.value.toFixed(2) : a.value) : ''}</strong> — ${a.msg}
      </div>`).join('');
    return `<div class="ap-section">
      <div class="ap-section-title">🔍 Validación de Métricas Input (${alerts.length} ${alerts.length === 1 ? 'alerta' : 'alertas'})</div>
      ${html}</div>`;
  }

  function renderCrossValidationSection(U) {
    const alerts = U.crossValidation || [];
    if (alerts.length === 0) {
      return `<div class="ap-section"><div class="ap-section-title">🔗 Cross-validation entre Métricas</div>
        <div class="ap-alert info">Las métricas son internamente consistentes. Los cálculos del proveedor cuadran entre sí.</div></div>`;
    }
    const html = alerts.map(a => `
      <div class="ap-alert ${a.severity === 'warn' ? 'warn' : 'info'}">
        <strong>${a.title}</strong> — ${a.msg}
      </div>`).join('');
    return `<div class="ap-section">
      <div class="ap-section-title">🔗 Cross-validation entre Métricas (${alerts.length} ${alerts.length === 1 ? 'discrepancia' : 'discrepancias'})</div>
      <div class="ap-alert info" style="margin-bottom:10px">Compara métricas que deberían ser coherentes entre sí. Discrepancias indican ajustes contables, definiciones no estándar o errores del proveedor.</div>
      ${html}</div>`;
  }

  function renderTemporalSection(U) {
    const t = U.temporal;
    if (!t) return '';
    const color = t.verdict === 'deterioro' ? '#f0483a' : t.verdict === 'monitorizar' ? '#f0b429' : '#22d45a';
    const label = t.verdict === 'deterioro' ? '⚠️ DETERIORO RECIENTE' : t.verdict === 'monitorizar' ? '🟡 MONITORIZAR' : '✅ SIN DETERIORO';
    const intro = t.verdict === 'deterioro'
      ? 'El último trimestre/año muestra varias señales de frenada respecto a la tendencia histórica. El CAGR 5y puede estar ocultando el problema actual.'
      : t.verdict === 'monitorizar'
      ? 'Hay al menos una señal de cambio de tendencia reciente. Monitorizar próximos reportes.'
      : 'Las métricas recientes son consistentes con la tendencia histórica.';

    const signals = t.signals.length ? t.signals.map(s => `
      <div class="ap-alert ${s.severity === 'warn' ? 'warn' : 'info'}">
        <strong>${s.label}</strong> — ${s.detail}
      </div>`).join('') : '';

    return `<div class="ap-section">
      <div class="ap-section-title">⏱️ Análisis Temporal — Últimos 12 meses vs tendencia 5y</div>
      <div class="ap-card" style="border-left-color:${color};margin-bottom:10px">
        <h4 style="color:${color}">${label}</h4>
        <div class="ap-lbl" style="margin-top:4px">${intro}</div>
      </div>
      ${signals}
    </div>`;
  }

  function renderCyclicalitySection(U) {
    const c = U.cyclicality;
    if (!c) return '';
    const verdictColor = c.verdict === 'peak_suspected' || c.verdict === 'cyclical_peak_suspected' ? '#f0835a'
                      : c.verdict === 'monitor' ? '#f0b429' : '#22d45a';
    const verdictLabel = c.verdict === 'cyclical_peak_suspected' ? '🎢 SECTOR CÍCLICO EN PICO'
                       : c.verdict === 'peak_suspected' ? '⚠️ POSIBLE PICO DE CICLO'
                       : c.verdict === 'monitor' ? '🟡 SEÑAL AISLADA' : '✅ SIN SEÑALES DE CICLICIDAD';
    const intro = c.detected
      ? 'Los CAGR recientes (3y) difieren significativamente de los largos (10y) y/o los márgenes actuales están por encima de su media histórica. Los beneficios actuales pueden no ser extrapolables.'
      : 'No se detectan señales de que los beneficios estén en pico de ciclo. La tendencia parece secular.';

    const signals = c.signals.map(s => `
      <div class="ap-alert ${s.severity === 'warn' ? 'warn' : 'info'}">
        <strong>${s.label}</strong> — ${s.detail}
      </div>`).join('');

    return `<div class="ap-section">
      <div class="ap-section-title">🎢 Detección de Ciclicidad / Pico de Ciclo</div>
      <div class="ap-card" style="border-left-color:${verdictColor};margin-bottom:10px">
        <h4 style="color:${verdictColor}">${verdictLabel}</h4>
        <div class="ap-lbl" style="margin-top:4px">${intro}</div>
      </div>
      ${signals}
    </div>`;
  }

  function renderDCFSensitivitySection(U) {
    const d = U.dcfSensitivity;
    if (!d || !d.canRun) {
      return `<div class="ap-section"><div class="ap-section-title">📉 Sensibilidad del DCF</div>
        <div class="ap-alert info">No hay datos suficientes para calcular sensibilidad (se necesitan dcf_fair_value_upside y wacc).</div></div>`;
    }

    const scenariosHTML = d.scenarios.map(s => {
      const color = s.upside > 15 ? '#22d45a' : s.upside > 0 ? '#f0b429' : '#f0483a';
      return `
        <div class="ap-scenario">
          <h5>${s.label}</h5>
          <div class="v" style="color:${color}">${s.upside >= 0 ? '+' : ''}${s.upside.toFixed(1)}%</div>
          <div class="ap-lbl" style="margin-top:6px">
            WACC: ${s.wacc.toFixed(1)}%<br>g: ${s.gAssumed}%<br>
            <span class="ap-mini-tag" style="background:${color}22;color:${color}">${s.verdict}</span>
          </div>
        </div>`;
    }).join('');

    return `<div class="ap-section">
      <div class="ap-section-title">📉 Sensibilidad del DCF — ¿Es robusto el upside?</div>
      <div class="ap-card" style="border-left-color:${d.robustness.color};margin-bottom:10px">
        <h4 style="color:${d.robustness.color}">Robustez: ${d.robustness.label}</h4>
        <div class="ap-lbl" style="margin-top:4px">${d.robustness.msg}</div>
      </div>
      <div class="ap-scenario-grid">${scenariosHTML}</div>
      <div class="ap-lbl" style="margin-top:8px;font-style:italic">
        Asunción: 75% del valor del DCF proviene del terminal value. Un cambio de WACC±1% y g±1% afecta principalmente al terminal.
      </div>
    </div>`;
  }

  function renderStressTestSection(U) {
    const s = U.stressTest;
    if (!s || !s.canRun) {
      return `<div class="ap-section"><div class="ap-section-title">🌩️ Stress Test</div>
        <div class="ap-alert info">Datos insuficientes para stress test.</div></div>`;
    }
    const verdictColor = s.verdict === 'robust' ? '#22d45a' : s.verdict === 'fragile' ? '#f0b429' : '#f0483a';
    const verdictLabel = s.verdict === 'robust' ? '✅ SOBREVIVE' : s.verdict === 'fragile' ? '⚠️ FRÁGIL' : '❌ EN PELIGRO';
    const explanation = s.verdict === 'robust' ? 'Mantiene servicio de deuda y no viola covenants.'
                      : s.verdict === 'fragile' ? 'Aguanta ajustadamente — suspendería dividendos, refinanciaría a peor tipo.'
                      : 'Probable distress: covenants rotos, ampliación dilutiva o reestructuración.';
    const rows = s.details.map(d => `
      <div>
        <div class="ap-stress-row">
          <span class="ap-stress-lbl">${d.label}</span>
          <span class="ap-stress-val ${d.pass ? 'ok' : 'bad'}">${d.value}</span>
        </div>
        <div class="ap-stress-comment">${d.comment}</div>
      </div>`).join('');
    return `<div class="ap-section">
      <div class="ap-section-title">🌩️ Stress Test — Rev -30%, márgenes -30%</div>
      <div class="ap-card" style="border-left-color:${verdictColor};margin-bottom:10px">
        <h4 style="color:${verdictColor}">${verdictLabel}</h4>
        <div class="ap-lbl" style="margin-top:4px">${explanation}</div>
      </div>
      <div class="ap-card">${rows}</div></div>`;
  }

  function renderVerdictConditionsSection(R) {
    const scores = Object.entries(R.profileScores).map(([id, ps]) => ({ id, score: ps.quantScore }));
    scores.sort((a, b) => b.score - a.score);
    const bestProfileId = scores[0]?.id;
    if (!bestProfileId) return '';
    const cv = R.analystUpgrades.conditionalVerdicts[bestProfileId];
    if (!cv) return '';

    const conds = Object.entries(cv.conditions).map(([k, v]) => `
      <div class="ap-stress-row">
        <span class="ap-stress-lbl">${prettyCondition(k)}</span>
        <span class="ap-stress-val ${v ? 'ok' : 'bad'}">${v ? '✓' : '✗'}</span>
      </div>`).join('');

    const PROFILES = window.PROFILES || {};
    const pname = PROFILES[bestProfileId]?.name || bestProfileId;
    const alertCls = cv.verdict === 'COMPRAR' ? 'info' : cv.verdict === 'WATCHLIST' ? 'warn' : 'bad';

    return `<div class="ap-section">
      <div class="ap-section-title">🎯 Condiciones del Veredicto (perfil top: ${pname})</div>
      <div class="ap-alert ${alertCls}"><strong>${cv.verdict}</strong> — ${cv.reason}</div>
      <div class="ap-card" style="margin-top:8px">${conds}</div></div>`;
  }

  function renderDevilsSummary() {
    const j = window.__devilsJustifications || {};
    const count = Object.keys(j).length;
    if (count === 0) {
      return `<div class="ap-section">
        <div class="ap-section-title">😈 Devil's Advocate</div>
        <div class="ap-alert info">Al responder "Sí" a preguntas críticas del checklist cualitativo, se te pedirá justificación breve. Esto combate el sesgo de confirmación. No hay justificaciones guardadas aún.</div>
      </div>`;
    }
    const rows = Object.entries(j).map(([qId, txt]) => {
      const allQs = Object.values(window.CHECKLIST || {}).flatMap(s => s.questions || []);
      const q = allQs.find(qq => qq.id === qId);
      return `<div class="ap-alert info">
        <strong>${q?.text || qId}</strong><br>
        <em style="color:#c9d1d9">"${txt}"</em>
      </div>`;
    }).join('');
    return `<div class="ap-section">
      <div class="ap-section-title">😈 Devil's Advocate — Justificaciones (${count})</div>
      ${rows}</div>`;
  }

  function prettyCondition(key) {
    return {
      scoreHigh: 'Score global ≥ 70%',
      profitabilityOk: 'Rentabilidad (M1) ≥ 60-65%',
      qualityOk: 'Calidad financiera (M3) ≥ 60-65%',
      riskOk: 'Riesgo/deuda (M4) ≥ 55%',
      valuationOk: 'Valoración (M6 o M7) soporta precio',
      growthOk: 'Crecimiento (M2) ≥ 60%',
      noVeto: 'Sin vetos absolutos M0',
      fvConfidenceOk: 'FV Confidence ≠ LOW',
      noRecentDeterioration: 'Sin deterioro reciente (v2)',
      notAtPeak: 'No en pico de ciclo (v2)',
    }[key] || key;
  }

  console.log('%c[AnalystUpgrades v2.0] Cargado correctamente', 'color:#22d45a;font-weight:700');
  console.log('14 mejoras activas (8 de v1 + 6 de v2):');
  console.log('  v1: #1-#8');
  console.log('  v2: #9  Devil\'s Advocate (preguntas críticas)');
  console.log('      #10 Cross-validation de métricas');
  console.log('      #11 Detección de ciclicidad / pico de ciclo');
  console.log('      #12 Sensibilidad del DCF');
  console.log('      #13 Ajustes IFRS/mercado europeo');
  console.log('      #14 Análisis temporal (deterioro reciente)');
})();

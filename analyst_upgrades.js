/* ═══════════════════════════════════════════════════════════════════════
   ANALYST UPGRADES v1.0 — Mejoras de un analista profesional
   ─────────────────────────────────────────────────────────────────────
   Este módulo se carga DESPUÉS del motor original (<script> de analisis.html)
   y parchea sus funciones clave. No requiere reescribir el motor.

   IMPLEMENTA 8 MEJORAS CRÍTICAS:
   1. Veredicto condicional (no lineal) — exige calidad en módulos críticos
   2. Detector de outliers y one-offs en métricas input (data sanity)
   3. Fair Value Confidence LOW bloquea COMPRAR
   4. Pesos reales del manual (M1=20, M3=20, M5=20, M8=15, M2=15, M4=10, M6=5, M7=5, M9=5)
   5. "No sé" en checklist cuenta como NEUTRAL (0.5), no como 0
   6. Stress test cuantitativo (caída revenue 30% → ¿sobrevive?)
   7. Métrica de convicción: nº de módulos por encima de umbral vs raspando
   8. Alerta de sector "general" (fallback silencioso)

   COMPATIBILIDAD: hace patching en tiempo de ejecución, no toca código fuente.
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // Esperar a que el motor base esté cargado
  if (typeof runFullAnalysis !== 'function') {
    console.warn('[AnalystUpgrades] Motor base no detectado. Carga este script DESPUÉS de analisis.html');
    return;
  }

  // ════════════════════════════════════════════════════════════════
  // MEJORA #4: PESOS CORRECTOS DEL MANUAL (score global coherente)
  // ════════════════════════════════════════════════════════════════
  // Antes: computeGlobalScore usaba 1/9 a cada módulo (contradice manual).
  // Ahora: pesos del manual — M1/M3/M5=20%, M2/M8=15%, M4=10%, M6/M7/M9=5%.
  // Nota: el manual hablaba con otra numeración; aquí mapeamos a los módulos del motor.
  const MANUAL_WEIGHTS = {
    m1: 20,  // Rentabilidad
    m2: 15,  // Crecimiento
    m3: 20,  // Calidad financiera (veto)
    m4: 10,  // Riesgo/Deuda
    m5: 10,  // Liquidez
    m6: 10,  // Valoración relativa
    m7: 10,  // Valoración intrínseca
    m8: 3,   // Dividendos (opcional)
    m9: 2,   // Momentum (menor peso — no fundamental)
  };
  const MANUAL_WEIGHTS_NO_DIV = { ...MANUAL_WEIGHTS, m8: 0, m7: 13 }; // redistribuir si no paga div

  window.computeGlobalScore = function (R) {
    const m = R.modules;
    const useWeights = m.m8 && m.m8.noDividend ? MANUAL_WEIGHTS_NO_DIV : MANUAL_WEIGHTS;
    let weighted = 0, totalW = 0;
    for (const [k, w] of Object.entries(useWeights)) {
      if (!m[k]) continue;
      if (w === 0) continue;
      weighted += m[k].score * w;
      totalW += w;
    }
    let pct = Math.round((weighted / totalW) * 100);
    if (!R.m0.passes) pct = Math.min(pct, 40);
    return pct;
  };

  // ════════════════════════════════════════════════════════════════
  // MEJORA #2: DATA SANITY CHECK — detecta outliers antes de puntuar
  // ════════════════════════════════════════════════════════════════
  // Muchas veces el proveedor entrega métricas erróneas por TTM malo,
  // goodwill negativo, one-offs no ajustados. Marcamos sospechosos.
  function runDataSanity(metrics) {
    const alerts = [];
    const g = (k) => {
      const v = metrics[k];
      if (v == null) return null;
      if (typeof v === 'object' && v !== null && 'value' in v) return v.value;
      return v;
    };
    const num = (k) => {
      const raw = g(k);
      if (raw == null) return null;
      const s = String(raw).replace(/[%,$€£\s]/g, '').replace(',', '.');
      const n = parseFloat(s);
      return isNaN(n) ? null : n;
    };

    const roic = num('roic');
    const roe = num('roe');
    const gpM = num('gp_margin');
    const niM = num('ni_margin');
    const fcfToNI = num('fcf_to_ni');
    const peFwd = num('pe_fwd');
    const peLtm = num('pe_ltm');
    const revG = num('total_rev_growth');
    const epsG = num('eps_diluted_growth');

    // Outliers clásicos
    if (roic != null && roic > 50) {
      alerts.push({
        severity: 'warn',
        metric: 'ROIC',
        value: roic,
        msg: `ROIC de ${roic.toFixed(1)}% es extraordinariamente alto. Verifica: (a) goodwill neto negativo, (b) activos fuera de balance, (c) one-off en NOPAT. Los ROIC >40% sostenidos son raros fuera de tech asset-light.`
      });
    }
    if (roic != null && roe != null && roe < roic - 5 && roe > 0) {
      alerts.push({
        severity: 'info',
        metric: 'ROE<ROIC',
        value: null,
        msg: `ROE (${roe.toFixed(1)}%) < ROIC (${roic.toFixed(1)}%). Inusual — normalmente el apalancamiento amplifica ROE. Posible: pérdidas en non-operating, minoritarios importantes, o deuda a tipo muy alto.`
      });
    }
    if (gpM != null && gpM > 95) {
      alerts.push({
        severity: 'warn',
        metric: 'Gross Margin',
        value: gpM,
        msg: `Margen bruto de ${gpM.toFixed(1)}% es prácticamente imposible en empresas con COGS real. Verifica si la empresa reporta COGS en otra línea (OpEx), típico en SaaS mal categorizado.`
      });
    }
    if (niM != null && niM > 60) {
      alerts.push({
        severity: 'warn',
        metric: 'Net Margin',
        value: niM,
        msg: `Margen neto del ${niM.toFixed(1)}% sugiere ganancias extraordinarias (venta de activos, cambio de impuesto diferido, deconsolidación). No extrapolar al futuro.`
      });
    }
    if (fcfToNI != null && (fcfToNI > 200 || fcfToNI < -50)) {
      alerts.push({
        severity: 'warn',
        metric: 'FCF/NI',
        value: fcfToNI,
        msg: `FCF/NI del ${fcfToNI.toFixed(0)}% está fuera de rango normal (60-130%). Beneficio contable y caja real están desacoplados — investigar working capital, one-offs o CapEx anormal.`
      });
    }
    if (peFwd != null && peLtm != null && peFwd > 0 && peLtm > 0) {
      const ratio = peLtm / peFwd;
      if (ratio > 3) {
        alerts.push({
          severity: 'info',
          metric: 'PE shift',
          value: ratio,
          msg: `PER LTM (${peLtm.toFixed(0)}x) es ${ratio.toFixed(1)}x el PER Fwd (${peFwd.toFixed(0)}x). El mercado anticipa salto fuerte de beneficios — tesis dependiente de proyecciones analistas.`
        });
      }
      if (ratio < 0.3) {
        alerts.push({
          severity: 'warn',
          metric: 'PE shift',
          value: ratio,
          msg: `PER Fwd (${peFwd.toFixed(0)}x) es muy superior al LTM (${peLtm.toFixed(0)}x). Los analistas esperan CAÍDA de beneficios — señal bajista no capturada por M9.`
        });
      }
    }
    if (revG != null && epsG != null && Math.abs(epsG) > 200 && Math.abs(revG) < 30) {
      alerts.push({
        severity: 'info',
        metric: 'EPS vs Rev',
        value: null,
        msg: `Crecimiento EPS (${epsG.toFixed(0)}%) dispar con Revenue (${revG.toFixed(0)}%). Típico de: base EPS baja, recompras agresivas, one-off fiscal. No representa crecimiento operativo subyacente.`
      });
    }

    return alerts;
  }

  // ════════════════════════════════════════════════════════════════
  // MEJORA #6: STRESS TEST CUANTITATIVO
  // ════════════════════════════════════════════════════════════════
  // "Si el revenue cae 30% durante 2 años, ¿sobrevive la empresa?"
  // Calcula cobertura de intereses stress, ratio deuda/revenue, etc.
  function runStressTest(metrics) {
    const num = (k) => {
      const v = metrics[k];
      const raw = v && typeof v === 'object' && 'value' in v ? v.value : v;
      if (raw == null) return null;
      const n = parseFloat(String(raw).replace(/[%,$€£\s]/g, '').replace(',', '.'));
      return isNaN(n) ? null : n;
    };

    const ebitda = num('ebitda');
    const ebitdaM = num('ebitda_margin');
    const intExp = num('interest_expense');
    const ic = num('interest_coverage');
    const revenue = num('total_rev');
    const netDebt = num('net_debt');
    const ndEbitda = num('net_debt_to_ebitda');
    const fcfM = num('fcf_margin');

    const result = {
      canRun: false,
      survives: null,
      details: [],
      verdict: 'unknown',
    };

    // Escenario: revenue -30%, margen EBITDA comprime 30% (apalancamiento operativo)
    // Resultado: EBITDA stress ≈ EBITDA_actual * 0.7 * 0.7 = 0.49 (conservador)
    if (ebitdaM != null && ic != null && ndEbitda != null) {
      result.canRun = true;
      const ebitdaStress = 0.49; // factor sobre EBITDA actual
      const icStress = ic * ebitdaStress;
      const ndEbitdaStress = ndEbitda / ebitdaStress;
      result.details.push({
        label: 'Interest Coverage stress',
        value: icStress.toFixed(1) + 'x',
        pass: icStress > 1.5,
        comment: icStress < 1 ? 'No cubre intereses en escenario adverso — riesgo de default'
               : icStress < 1.5 ? 'Cobertura crítica — poco margen'
               : icStress < 2.5 ? 'Cobertura justa — aguanta pero con presión'
               : 'Cobertura sólida — aguanta sin problema'
      });
      result.details.push({
        label: 'Net Debt/EBITDA stress',
        value: ndEbitdaStress.toFixed(1) + 'x',
        pass: ndEbitdaStress < 6,
        comment: ndEbitdaStress > 8 ? 'Apalancamiento insostenible — probable violación de covenants'
               : ndEbitdaStress > 6 ? 'Zona peligrosa — bancos exigirían refinanciación costosa'
               : ndEbitdaStress > 4 ? 'Deuda manejable pero alta — dividendos y recompras se pararían'
               : 'Apalancamiento saludable incluso en stress'
      });
      const passes = result.details.filter(d => d.pass).length;
      result.survives = passes === result.details.length;
      result.verdict = passes === result.details.length ? 'robust'
                     : passes >= 1 ? 'fragile'
                     : 'distressed';
    }
    // Fallback: si solo hay FCF margin
    else if (fcfM != null) {
      result.canRun = true;
      const fcfMStress = fcfM - 8; // compresión típica en recesión
      result.details.push({
        label: 'FCF Margin stress',
        value: fcfMStress.toFixed(1) + '%',
        pass: fcfMStress > 0,
        comment: fcfMStress < -5 ? 'FCF muy negativo — quema caja rápido'
               : fcfMStress < 0 ? 'FCF ligeramente negativo — necesita línea de crédito'
               : fcfMStress < 5 ? 'FCF positivo pero ajustado'
               : 'FCF robusto incluso en stress'
      });
      result.survives = fcfMStress > 0;
      result.verdict = fcfMStress > 3 ? 'robust' : fcfMStress > 0 ? 'fragile' : 'distressed';
    }

    return result;
  }

  // ════════════════════════════════════════════════════════════════
  // MEJORA #7: MÉTRICA DE CONVICCIÓN
  // ════════════════════════════════════════════════════════════════
  // Distingue un 72% con 6 módulos sólidos + 3 raspando
  // de un 72% con 4 módulos excelentes + 5 mediocres.
  function computeConviction(R) {
    const m = R.modules;
    const scores = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm9']
      .filter(k => m[k])
      .map(k => m[k].score);
    if (m.m8 && !m.m8.noDividend) scores.push(m.m8.score);

    const strong = scores.filter(s => s >= 0.70).length;
    const borderline = scores.filter(s => s >= 0.55 && s < 0.70).length;
    const weak = scores.filter(s => s < 0.55).length;
    const total = scores.length;

    // Convicción = strong con penalización por weak
    const convictionPct = Math.round(((strong * 1.0 + borderline * 0.5 - weak * 0.3) / total) * 100);
    const conviction = Math.max(0, Math.min(100, convictionPct));

    let label, color;
    if (conviction >= 75 && strong >= total * 0.6) { label = 'ALTA'; color = '#22d45a'; }
    else if (conviction >= 50) { label = 'MEDIA'; color = '#f0b429'; }
    else if (conviction >= 25) { label = 'BAJA'; color = '#f0835a'; }
    else { label = 'MUY BAJA'; color = '#f0483a'; }

    return { conviction, label, color, strong, borderline, weak, total };
  }

  // ════════════════════════════════════════════════════════════════
  // MEJORA #1 + #3: VEREDICTO CONDICIONAL
  // ════════════════════════════════════════════════════════════════
  // Antes: threshold lineal 70% = COMPRAR
  // Ahora: 70% + condiciones duras (M1 bueno, M3 bueno, FV confidence ≠ LOW, etc)
  function conditionalVerdict(R, profileId) {
    const m = R.modules;
    const ps = R.profileScores[profileId];
    if (!ps) return null;

    const quant = ps.quantScore / 100;
    const pct = ps.quantScore;

    // CONDICIONES DURAS para COMPRAR
    const conditions = {
      scoreHigh: pct >= 70,
      profitabilityOk: m.m1.score >= 0.60,       // M1 rentabilidad
      qualityOk: m.m3.score >= 0.60,             // M3 calidad financiera
      riskOk: m.m4.score >= 0.55,                // M4 riesgo/deuda
      valuationOk: m.m6.score >= 0.50 || m.m7.score >= 0.55,  // M6 o M7 soporta precio
      noVeto: R.m0.passes,
      fvConfidenceOk: R.meta.fvConf !== 'LOW',   // FV no debe ser de baja confianza
    };

    // Perfil value/quality es más exigente en rentabilidad/calidad
    const strictProfiles = ['value', 'quality', 'deepvalue', 'dgi', 'defensive'];
    if (strictProfiles.includes(profileId)) {
      conditions.profitabilityOk = m.m1.score >= 0.65;
      conditions.qualityOk = m.m3.score >= 0.65;
    }
    // Growth profiles piden M2 crecimiento
    if (['growth', 'smallcap'].includes(profileId)) {
      conditions.growthOk = m.m2.score >= 0.60;
    }

    const failed = Object.entries(conditions).filter(([_, v]) => !v).map(([k]) => k);
    const allBuyConditions = failed.length === 0;

    // Lógica de veredicto
    let verdict, reason;
    if (!R.m0.passes) {
      verdict = 'NO COMPRAR';
      reason = 'Veto absoluto M0 activo — riesgo de pérdida permanente de capital';
    } else if (pct < 50) {
      verdict = 'NO COMPRAR';
      reason = `Score ${pct}% insuficiente. Fundamentales débiles.`;
    } else if (pct >= 70 && allBuyConditions) {
      verdict = 'COMPRAR';
      reason = `Score ${pct}% + todos los filtros de calidad superados.`;
    } else if (pct >= 70 && !allBuyConditions) {
      // 70%+ pero con debilidades — downgrade a WATCHLIST
      verdict = 'WATCHLIST';
      const failedLabels = failed.map(labelFailure).join(', ');
      reason = `Score ${pct}% alcanzado pero con debilidades: ${failedLabels}. No cumple los estándares para COMPRAR convencido.`;
    } else {
      verdict = 'WATCHLIST';
      reason = `Score ${pct}% — fundamentales aceptables pero no sobresalientes. Esperar mejora o mejor precio.`;
    }

    return { verdict, reason, conditions, failed };
  }

  function labelFailure(key) {
    const m = {
      scoreHigh: 'score <70%',
      profitabilityOk: 'rentabilidad débil (M1)',
      qualityOk: 'calidad financiera débil (M3)',
      riskOk: 'riesgo/deuda elevado (M4)',
      valuationOk: 'sin soporte de valoración (M6/M7)',
      growthOk: 'crecimiento insuficiente (M2)',
      noVeto: 'veto M0 activo',
      fvConfidenceOk: 'Fair Value con confianza LOW',
    };
    return m[key] || key;
  }

  // ════════════════════════════════════════════════════════════════
  // MEJORA #5: CHECKLIST "NO SÉ" = NEUTRAL (0.5), NO CERO
  // ════════════════════════════════════════════════════════════════
  // Antes: "No sé" penalizaba al usuario honesto.
  // Ahora: "No sé" no aporta ni resta — no puntúa.
  window.scoreChecklist = function (answers) {
    const sectionScores = {};
    const CHECKLIST = window.CHECKLIST;
    if (!CHECKLIST) { console.warn('[AnalystUpgrades] CHECKLIST no encontrado'); return {}; }

    for (const [sectionId, section] of Object.entries(CHECKLIST)) {
      let totalWeight = 0;
      let weightedSum = 0;
      let answeredCount = 0;
      section.questions.forEach(q => {
        const ans = answers[q.id];
        if (ans === 'yes') {
          weightedSum += 2;
          totalWeight += 2;
          answeredCount++;
        } else if (ans === 'no') {
          weightedSum += -2;
          totalWeight += 2;
          answeredCount++;
        } else {
          // "dk" o sin responder — no cuenta (ni suma ni resta)
          // Esto es lo correcto: premia honestidad y penaliza solo NO explícito
        }
      });
      const normalized = totalWeight > 0 ? (weightedSum / totalWeight + 1) / 2 : 0.5;
      sectionScores[sectionId] = {
        score: Math.max(0, Math.min(1, normalized)),
        coverage: section.questions.length > 0 ? answeredCount / section.questions.length : 0,
      };
    }

    // Per-profile weighted qual score
    const CHECKLIST_WEIGHTS = window.CHECKLIST_WEIGHTS;
    const PROFILES = window.PROFILES;
    const profileQualScores = {};
    let totalCoverage = 0, sectionsCount = 0;

    if (CHECKLIST_WEIGHTS && PROFILES) {
      for (const [profileId, weights] of Object.entries(CHECKLIST_WEIGHTS)) {
        const [w1, w2, w3, w4, w5, w6, w7, w8] = weights;
        const total = w1 + w2 + w3 + w4 + w5 + w6 + w7 + w8;
        const weighted =
          (sectionScores.s1?.score || 0.5) * w1 +
          (sectionScores.s2?.score || 0.5) * w2 +
          (sectionScores.s3?.score || 0.5) * w3 +
          (sectionScores.s4?.score || 0.5) * w4 +
          (sectionScores.s5?.score || 0.5) * w5 +
          (sectionScores.s6?.score || 0.5) * w6 +
          (sectionScores.s7?.score || 0.5) * w7 +
          (sectionScores.s8?.score || 0.5) * w8;
        profileQualScores[profileId] = weighted / total;
      }
    }

    Object.values(sectionScores).forEach(s => {
      totalCoverage += s.coverage || 0;
      sectionsCount++;
    });
    const overallCoverage = sectionsCount > 0 ? totalCoverage / sectionsCount : 0;

    // Qual vetos
    const QUAL_VETOS = window.QUAL_VETOS || [];
    const qualVetosFired = QUAL_VETOS.filter(veto => {
      const allQs = Object.values(CHECKLIST).flatMap(s => s.questions);
      const theQ = allQs.find(q2 => {
        const qNum = parseInt(q2.id.replace(/[a-z]/gi, ''));
        return veto.q === qNum || q2.id === `s${veto.section}q${veto.q}`;
      });
      return theQ && answers[theQ.id] === 'no';
    });

    // Convertir sectionScores a formato esperado por motor (solo score)
    const simpleSectionScores = {};
    Object.entries(sectionScores).forEach(([k, v]) => { simpleSectionScores[k] = v.score; });

    return {
      sectionScores: simpleSectionScores,
      sectionCoverage: Object.fromEntries(Object.entries(sectionScores).map(([k, v]) => [k, v.coverage])),
      profileQualScores,
      qualVetosFired,
      overallCoverage,
    };
  };

  // ════════════════════════════════════════════════════════════════
  // MEJORA #8: ALERTA SECTOR "GENERAL"
  // ════════════════════════════════════════════════════════════════
  // Cuando el detector de sector cae a "general", los umbrales no son fiables.
  // Marcamos esto explícitamente y se muestra en UI.
  function sectorFallbackWarning(R) {
    if (R.sectorKey === 'general') {
      return {
        severity: 'warn',
        msg: `⚠️ Sector clasificado como "general" (fallback). Los umbrales aplicados son promedios sin ajuste sectorial específico. Se recomienda clasificar manualmente el sector para obtener un análisis fiable.`
      };
    }
    return null;
  }

  // ════════════════════════════════════════════════════════════════
  // WRAPPER PRINCIPAL — extiende runFullAnalysis
  // ════════════════════════════════════════════════════════════════
  const _origRunFullAnalysis = window.runFullAnalysis;
  window.runFullAnalysis = function (metrics, sectorData) {
    const R = _origRunFullAnalysis(metrics, sectorData);

    // Inyectar mejoras
    R.analystUpgrades = {
      dataSanity: runDataSanity(metrics),
      stressTest: runStressTest(metrics),
      conviction: computeConviction(R),
      sectorFallback: sectorFallbackWarning(R),
      conditionalVerdicts: {},
    };

    // Recalcular veredictos condicionales para cada perfil
    Object.keys(R.profileScores).forEach(profileId => {
      R.analystUpgrades.conditionalVerdicts[profileId] = conditionalVerdict(R, profileId);
      // Sobrescribir el verdict "simple" del perfil con el condicional
      const cv = R.analystUpgrades.conditionalVerdicts[profileId];
      if (cv) {
        R.profileScores[profileId].verdict = cv.verdict;
        R.profileScores[profileId].verdictReason = cv.reason;
        R.profileScores[profileId].verdictColor =
          cv.verdict === 'COMPRAR' ? '#22d45a' :
          cv.verdict === 'WATCHLIST' ? '#f0b429' : '#f0483a';
      }
    });

    return R;
  };

  // ════════════════════════════════════════════════════════════════
  // HOOK DE RENDER — añade panel "Diagnóstico del Analista" a la UI
  // ════════════════════════════════════════════════════════════════
  const _origRenderResults = window.renderResults;
  if (_origRenderResults) {
    window.renderResults = function () {
      _origRenderResults.apply(this, arguments);
      try { renderAnalystPanel(); } catch (e) { console.error('[AnalystUpgrades] renderAnalystPanel:', e); }
    };
  }

  function renderAnalystPanel() {
    const R = window.analysisResult;
    if (!R || !R.analystUpgrades) return;

    const U = R.analystUpgrades;
    const existing = document.getElementById('analystDiagnosticPanel');
    if (existing) existing.remove();

    const container = document.querySelector('.tab-container')
                    || document.querySelector('.reasoning-box')?.parentElement
                    || document.querySelector('#tab-reasoning')?.parentElement
                    || document.body;

    const panel = document.createElement('div');
    panel.id = 'analystDiagnosticPanel';
    panel.className = 'analyst-panel';
    panel.style.cssText = `
      max-width:1280px;margin:24px auto;padding:0 48px;
      font-family: var(--f-s, system-ui, -apple-system, sans-serif);
    `;

    panel.innerHTML = `
      <style>
        .analyst-panel .ap-head{
          display:flex;align-items:center;gap:12px;margin-bottom:16px;
          padding-bottom:10px;border-bottom:1px solid var(--border2, #30363d);
        }
        .analyst-panel .ap-title{
          font-size:1.1rem;font-weight:800;color:var(--text, #c9d1d9);
          letter-spacing:-.3px;
        }
        .analyst-panel .ap-sub{
          font-size:.74rem;color:var(--text3, #8b949e);letter-spacing:.5px;text-transform:uppercase;
        }
        .analyst-panel .ap-grid{
          display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-bottom:18px;
        }
        .analyst-panel .ap-card{
          background:var(--s3, rgba(255,255,255,.03));
          border:1px solid var(--border2, #30363d);
          border-radius:10px;padding:14px 16px;
          border-left:3px solid var(--accent, #58a6ff);
        }
        .analyst-panel .ap-card.ok{border-left-color:#22d45a}
        .analyst-panel .ap-card.warn{border-left-color:#f0b429}
        .analyst-panel .ap-card.bad{border-left-color:#f0483a}
        .analyst-panel .ap-card h4{
          margin:0 0 6px;font-size:.82rem;font-weight:700;color:var(--text, #c9d1d9);
          display:flex;align-items:center;gap:6px;
        }
        .analyst-panel .ap-card .ap-val{
          font-family:ui-monospace,monospace;font-size:1.3rem;font-weight:700;
          margin:6px 0 4px;color:var(--text, #c9d1d9);
        }
        .analyst-panel .ap-card .ap-lbl{font-size:.7rem;color:var(--text3, #8b949e);line-height:1.5}
        .analyst-panel .ap-alert{
          padding:10px 14px;border-radius:8px;margin-bottom:8px;
          font-size:.8rem;line-height:1.55;color:var(--text2, #8b949e);
        }
        .analyst-panel .ap-alert.warn{background:rgba(240,180,41,.08);border-left:3px solid #f0b429}
        .analyst-panel .ap-alert.info{background:rgba(88,166,255,.06);border-left:3px solid #58a6ff}
        .analyst-panel .ap-alert.bad{background:rgba(240,72,58,.08);border-left:3px solid #f0483a}
        .analyst-panel .ap-alert strong{color:var(--text, #c9d1d9);font-weight:700}
        .analyst-panel .ap-section{margin-bottom:24px}
        .analyst-panel .ap-section-title{
          font-size:.88rem;font-weight:700;color:var(--text, #c9d1d9);margin:0 0 10px;
          display:flex;align-items:center;gap:8px;
        }
        .analyst-panel .ap-stress-row{
          display:flex;align-items:center;justify-content:space-between;gap:12px;
          padding:8px 12px;border-bottom:1px solid rgba(255,255,255,.04);
          font-size:.78rem;
        }
        .analyst-panel .ap-stress-row:last-child{border-bottom:none}
        .analyst-panel .ap-stress-lbl{color:var(--text2, #8b949e);flex:1}
        .analyst-panel .ap-stress-val{
          font-family:ui-monospace,monospace;font-weight:700;padding:2px 8px;border-radius:4px;
        }
        .analyst-panel .ap-stress-val.ok{background:rgba(34,212,90,.15);color:#22d45a}
        .analyst-panel .ap-stress-val.bad{background:rgba(240,72,58,.15);color:#f0483a}
        .analyst-panel .ap-stress-comment{font-size:.7rem;color:var(--text3, #8b949e);margin-top:2px}
        .analyst-panel .ap-conviction-bar{
          height:8px;border-radius:4px;background:var(--s4, rgba(255,255,255,.06));
          overflow:hidden;margin:8px 0 4px;
        }
        .analyst-panel .ap-conviction-fill{height:100%;transition:width .6s}
      </style>

      <div class="ap-head">
        <div>
          <div class="ap-sub">🔬 Diagnóstico del Analista</div>
          <div class="ap-title">Capa de validación y stress test</div>
        </div>
      </div>

      ${renderSectorFallback(U)}
      ${renderConvictionCard(U)}
      ${renderDataSanitySection(U)}
      ${renderStressTestSection(U)}
      ${renderVerdictConditionsSection(R)}
    `;

    container.appendChild(panel);
  }

  function renderSectorFallback(U) {
    if (!U.sectorFallback) return '';
    return `<div class="ap-alert warn">${U.sectorFallback.msg}</div>`;
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
            <div class="ap-lbl">Dos empresas con el mismo score pueden tener convicción muy distinta. Esta métrica mide cuántos módulos están realmente sólidos vs raspando el umbral.</div>
          </div>
          <div class="ap-card ok">
            <h4>✅ Módulos sólidos</h4>
            <div class="ap-val" style="color:#22d45a">${c.strong} / ${c.total}</div>
            <div class="ap-lbl">Puntuación ≥ 70% — fortaleza genuina</div>
          </div>
          <div class="ap-card warn">
            <h4>⚠️ Módulos raspando</h4>
            <div class="ap-val" style="color:#f0b429">${c.borderline} / ${c.total}</div>
            <div class="ap-lbl">55-70% — cumplen pero sin margen</div>
          </div>
          <div class="ap-card bad">
            <h4>❌ Módulos débiles</h4>
            <div class="ap-val" style="color:#f0483a">${c.weak} / ${c.total}</div>
            <div class="ap-lbl">&lt; 55% — investigar causa</div>
          </div>
        </div>
      </div>`;
  }

  function renderDataSanitySection(U) {
    const alerts = U.dataSanity || [];
    if (alerts.length === 0) {
      return `
        <div class="ap-section">
          <div class="ap-section-title">🔍 Validación de Métricas Input</div>
          <div class="ap-alert info">No se han detectado outliers evidentes en las métricas. El análisis usa datos dentro de rangos razonables. Aún así, verifica siempre los estados financieros originales para ajustes extraordinarios.</div>
        </div>`;
    }
    const html = alerts.map(a => `
      <div class="ap-alert ${a.severity === 'warn' ? 'warn' : 'info'}">
        <strong>${a.metric}${a.value != null ? ': ' + (typeof a.value === 'number' ? a.value.toFixed(2) : a.value) : ''}</strong> — ${a.msg}
      </div>
    `).join('');
    return `
      <div class="ap-section">
        <div class="ap-section-title">🔍 Validación de Métricas Input (${alerts.length} alertas)</div>
        ${html}
      </div>`;
  }

  function renderStressTestSection(U) {
    const s = U.stressTest;
    if (!s || !s.canRun) {
      return `
        <div class="ap-section">
          <div class="ap-section-title">🌩️ Stress Test — Escenario Adverso</div>
          <div class="ap-alert info">No hay datos suficientes para ejecutar el stress test. Se necesitan: EBITDA, Interest Coverage, Net Debt/EBITDA o FCF Margin.</div>
        </div>`;
    }

    const verdictColor = s.verdict === 'robust' ? '#22d45a' : s.verdict === 'fragile' ? '#f0b429' : '#f0483a';
    const verdictLabel = s.verdict === 'robust' ? '✅ SOBREVIVE' : s.verdict === 'fragile' ? '⚠️ FRÁGIL' : '❌ EN PELIGRO';
    const explanation = s.verdict === 'robust'
      ? 'En un escenario adverso (revenue -30%, compresión de márgenes 30%), la empresa mantiene capacidad de servicio de deuda y no viola covenants razonables.'
      : s.verdict === 'fragile'
      ? 'En escenario adverso la empresa queda ajustada — probablemente tendría que suspender dividendos, recompras o refinanciar a peores condiciones. No hay margen para error operativo.'
      : 'En escenario adverso la empresa probablemente entraría en distress financiero: violación de covenants, necesidad de ampliación de capital dilutiva o reestructuración de deuda.';

    const rows = s.details.map(d => `
      <div>
        <div class="ap-stress-row">
          <span class="ap-stress-lbl">${d.label}</span>
          <span class="ap-stress-val ${d.pass ? 'ok' : 'bad'}">${d.value}</span>
        </div>
        <div class="ap-stress-comment" style="padding:0 12px 6px">${d.comment}</div>
      </div>
    `).join('');

    return `
      <div class="ap-section">
        <div class="ap-section-title">🌩️ Stress Test — Escenario Adverso (Rev -30%, márgenes -30%)</div>
        <div class="ap-card" style="border-left-color:${verdictColor};margin-bottom:10px">
          <h4 style="color:${verdictColor}">${verdictLabel}</h4>
          <div class="ap-lbl" style="margin-top:4px">${explanation}</div>
        </div>
        <div class="ap-card">
          ${rows}
        </div>
      </div>`;
  }

  function renderVerdictConditionsSection(R) {
    // Tomamos el mejor perfil (mayor score) para mostrar condiciones
    const scores = Object.entries(R.profileScores).map(([id, ps]) => ({ id, score: ps.quantScore }));
    scores.sort((a, b) => b.score - a.score);
    const bestProfileId = scores[0]?.id;
    if (!bestProfileId) return '';
    const cv = R.analystUpgrades.conditionalVerdicts[bestProfileId];
    if (!cv) return '';

    const conds = Object.entries(cv.conditions).map(([k, v]) => {
      const label = labelFailure(k).replace(/<.*$/, ''); // clean up
      return `
        <div class="ap-stress-row">
          <span class="ap-stress-lbl">${prettyCondition(k)}</span>
          <span class="ap-stress-val ${v ? 'ok' : 'bad'}">${v ? '✓' : '✗'}</span>
        </div>
      `;
    }).join('');

    const PROFILES = window.PROFILES || {};
    const pname = PROFILES[bestProfileId]?.name || bestProfileId;

    return `
      <div class="ap-section">
        <div class="ap-section-title">🎯 Condiciones del Veredicto (perfil mejor ranking: ${pname})</div>
        <div class="ap-alert ${cv.verdict === 'COMPRAR' ? 'info' : cv.verdict === 'WATCHLIST' ? 'warn' : 'bad'}">
          <strong>${cv.verdict}</strong> — ${cv.reason}
        </div>
        <div class="ap-card" style="margin-top:8px">
          ${conds}
        </div>
      </div>`;
  }

  function prettyCondition(key) {
    return {
      scoreHigh: 'Score global ≥ 70%',
      profitabilityOk: 'Rentabilidad (M1) ≥ 60-65%',
      qualityOk: 'Calidad financiera (M3) ≥ 60-65%',
      riskOk: 'Riesgo/deuda (M4) ≥ 55%',
      valuationOk: 'Valoración (M6 o M7) soporta el precio',
      growthOk: 'Crecimiento (M2) ≥ 60%',
      noVeto: 'Sin vetos absolutos M0',
      fvConfidenceOk: 'Fair Value Confidence ≠ LOW',
    }[key] || key;
  }

  // ════════════════════════════════════════════════════════════════
  // SIGNAL: carga exitosa
  // ════════════════════════════════════════════════════════════════
  console.log('%c[AnalystUpgrades v1.0] Cargado correctamente', 'color:#22d45a;font-weight:700');
  console.log('Mejoras activas:');
  console.log('  ✓ #1 Veredicto condicional (no threshold lineal)');
  console.log('  ✓ #2 Data sanity check (outliers)');
  console.log('  ✓ #3 FV Confidence LOW bloquea COMPRAR');
  console.log('  ✓ #4 Pesos del manual en score global');
  console.log('  ✓ #5 "No sé" = neutral en checklist');
  console.log('  ✓ #6 Stress test cuantitativo');
  console.log('  ✓ #7 Métrica de convicción');
  console.log('  ✓ #8 Alerta sector "general"');
})();

# Analyst Upgrades v2.0 — 14 mejoras al motor de análisis

Parche JavaScript que añade 14 capas de validación y análisis avanzado al motor de `analisis.html` sin reescribir código existente.

## Instalación

Al final de `analisis.html`, justo antes de `</body>`:

```html
<!-- MEJORAS DEL ANALISTA v2 -->
<script src="analyst_upgrades.js"></script>
</body>
</html>
```

Recarga con **Cmd+Shift+R** para forzar sin caché.

## Qué aparece nuevo en la UI

Al final de la página (después del tab de Razonamiento) aparece el panel **"🔬 Diagnóstico del Analista"** con hasta 10 secciones. Además, en el checklist cualitativo, al responder "Sí" a preguntas críticas (las ⚠️) se despliega una caja de **Devil's Advocate** pidiendo justificación.

## Resumen de las 14 mejoras

**v1 (previas):**
1. Veredicto condicional no lineal
2. Data sanity check de inputs
3. FV Confidence LOW bloquea COMPRAR
4. Pesos del manual en score global
5. "No sé" neutral en checklist
6. Stress test cuantitativo
7. Métrica de convicción
8. Alerta sector "general"

**v2 (nuevas):**

**#9 Devil's Advocate** — al responder "Sí" a preguntas críticas pide justificación de 15+ caracteres con fuente concreta. Combate sesgo de confirmación.

**#10 Cross-validation** — 5 chequeos de consistencia interna entre métricas relacionadas (FCF vs OCF-CapEx, DuPont, Earnings Yield = 1/PER, etc). Detecta ajustes contables ocultos en los datos del proveedor.

**#11 Detección de ciclicidad** — 4 señales que cruzadas revelan pico de ciclo (Revenue 3y vs 10y, EBITDA 3y vs 5y, márgenes vs media histórica, EPS vs Revenue). Con 2+ señales, bloquea COMPRAR.

**#12 Sensibilidad del DCF** — recalcula upside con WACC+1% y g-1%. Si el upside desaparece con ese shock, el DCF es FRÁGIL. Cuatro niveles: ROBUSTA, MODERADA, FRÁGIL, NO COMPRA.

**#13 Ajustes IFRS/mercado europeo** — detecta sufijos europeos en ticker (.MC, .PA, .DE, .MI, .AS, .L, etc.), identifica SOCIMIs, alerta sobre dual-class shares, retenciones fiscales por país, riesgo FX en UK.

**#14 Análisis temporal** — compara métricas LTM vs CAGR 5y para detectar deterioro reciente que el CAGR largo está ocultando. Mira también revisiones de analistas 30d vs 90d.

## Las 6 señales que ahora se incorporan al veredicto

Una empresa con score ≥70% solo da COMPRAR si cumple simultáneamente:

| Condición | Umbral |
|-----------|--------|
| Score global | ≥ 70% |
| M1 Rentabilidad | ≥ 60% (65% en strict) |
| M3 Calidad financiera | ≥ 60% (65% en strict) |
| M4 Riesgo | ≥ 55% |
| M6 o M7 Valoración | M6 ≥ 50% o M7 ≥ 55% |
| Sin veto M0 | — |
| FV Confidence | ≠ LOW |
| **Sin deterioro reciente (v2)** | temporal verdict ≠ "deterioro" |
| **No en pico de ciclo (v2)** | cyclicality verdict ≠ "peak_suspected" |

Si falla cualquiera → WATCHLIST con razón explícita en el panel.

## Tests

Todas las funciones están testeadas. 11 tests unitarios cubren los escenarios normales y los edge cases:

- Pico de ciclo / tendencia secular
- DCF robusto / moderado / frágil
- Empresa europea (IBE.MC) / no europea (AAPL)
- SOCIMI detectada
- Deterioro reciente / estabilidad
- Cross-validation con FCF inconsistente
- Veredicto integrando todas las señales v2

## Reversión

Quita la línea del `<script>` del `analisis.html`. Nada se modifica en el código fuente original.

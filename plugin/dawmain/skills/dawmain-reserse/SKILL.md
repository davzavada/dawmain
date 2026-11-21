---
name: dawmain-reserse
description: Czech, Slovak and EU legal research through the Dawmain MCP connector (e-Sbírka, sněmovní tisky, NS, NSS, ÚS, obecné soudy, SDEU, EUR-Lex, literature; Slov-Lex: Zbierka zákonov SR, eLegislatíva, slovenské súdy) ending in a memo that cites every authority. Use it for ANY question whose answer turns on Czech, Slovak or EU law, even everyday ones naming no statute: "je možné / lze / smím / musím", "je to platné", "co mi hrozí, když", "jak postupovat" about smlouva, podpis, plná moc, výpověď, lhůta, nájem, pracovní poměr, GDPR, dědictví, firma, úřad. Also: "právní rešerše", "co na to judikatura", "najdi judikaturu k § X", "platí ještě", "co říká zákon o", "důvodová zpráva", "co na to doktrína"; any question about Slovakia ("na Slovensku", "slovenský zákon", "Z. z.", "NS SR", "dôvodová správa", CZ/SK comparison); and EU transposition ("který zákon transponuje / provádí směrnici 2004/48"). Requires the Dawmain connector; if its tools are absent, say so instead of guessing.
---

# Rešerše přes Dawmain

The full research manual lives on the server and is always current there, so this
skill only points at it.

1. Before the first search of a legal question, call `dawmain_guide` once (no
   arguments) and follow it: how to write the brief, how to aim queries at each court
   and database, how to read and cite, and how the memo is shaped. Call it in the same
   turn as your first searches, not as a step of its own.
2. When you go deep into one source, call `dawmain_guide` with that source in
   `topics` for its field reference.
3. Never answer a legal question from memory while the Dawmain tools are available, and
   never cite a decision or provision that a Dawmain tool did not return and you did
   not read.

If the Dawmain tools are missing, say that the Dawmain connector is not connected
(it is added on https://dawmain.davidzavada.cz) instead of guessing.

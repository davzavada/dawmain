"""Období běhů a generování úlohy Plánovače úloh Windows.

Období monitoringu se nastavuje v config.json klíčem "obdobi":
  "mesicne" (výchozí) - běh 1x měsíčně, značka období RRRR-MM
  "tydne"             - běh 1x týdně (pondělí), značka RRRR-WTT (ISO týden)
  "denne"             - běh každý den, značka RRRR-MM-DD

Značky řadí lexikograficky, takže porovnání "předchozí běh" v databázi
funguje pro všechna období stejně.
"""

import datetime
import re

OBDOBI = ("mesicne", "tydne", "denne")

_VZOR_ZNACKY = re.compile(r"\d{4}-(W\d{2}|\d{2}(-\d{2})?)")


def platna_znacka(znacka: str) -> bool:
    return bool(_VZOR_ZNACKY.fullmatch(znacka))


def znacka_obdobi(obdobi: str, dnes=None) -> str:
    """Značka aktuálního období pro daný typ ('mesicne'/'tydne'/'denne')."""
    dnes = dnes or datetime.date.today()
    if obdobi == "tydne":
        iso = dnes.isocalendar()
        return "%04d-W%02d" % (iso[0], iso[1])
    if obdobi == "denne":
        return dnes.strftime("%Y-%m-%d")
    return dnes.strftime("%Y-%m")


_SABLONA_ULOHY = """<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Monitoring novych domen .cz a .sk podle klicovych slov ({popis}; bezi bez admin prav pod prihlasenym uzivatelem)</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2026-01-01T{cas}:00</StartBoundary>
      <Enabled>true</Enabled>
{rozvrh}
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT4H</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>/c "{spousteni}"</Arguments>
      <WorkingDirectory>{cesta}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"""

_VSECHNY_MESICE = ("          <January/><February/><March/><April/><May/><June/>\n"
                   "          <July/><August/><September/><October/><November/><December/>")


def _rozvrh(obdobi: str, den_v_mesici: int) -> str:
    if obdobi == "tydne":
        return ("      <ScheduleByWeek>\n"
                "        <WeeksInterval>1</WeeksInterval>\n"
                "        <DaysOfWeek><Monday/></DaysOfWeek>\n"
                "      </ScheduleByWeek>")
    if obdobi == "denne":
        return ("      <ScheduleByDay>\n"
                "        <DaysInterval>1</DaysInterval>\n"
                "      </ScheduleByDay>")
    return ("      <ScheduleByMonth>\n"
            "        <DaysOfMonth>\n"
            "          <Day>%d</Day>\n"
            "        </DaysOfMonth>\n"
            "        <Months>\n%s\n        </Months>\n"
            "      </ScheduleByMonth>" % (den_v_mesici, _VSECHNY_MESICE))


def popis_rozvrhu(obdobi: str, den_v_mesici: int, cas: str) -> str:
    if obdobi == "tydne":
        return "kazde pondeli v %s" % cas
    if obdobi == "denne":
        return "kazdy den v %s" % cas
    return "%d. den v mesici v %s" % (den_v_mesici, cas)


def vytvor_xml_ulohy(koren: str, config: dict, spousteni: str) -> str:
    """Sestaví XML úlohy Plánovače podle konfigurace (vrací text).

    spousteni: příkaz pro cmd.exe /c - buď run.bat, nebo `py aplikace.pyz`
    u jednosouborové distribuce.
    """
    from xml.sax.saxutils import escape

    obdobi = config.get("obdobi", "mesicne")
    if obdobi not in OBDOBI:
        raise ValueError("Neznámé období %r - povolené hodnoty: %s"
                         % (obdobi, ", ".join(OBDOBI)))
    nastaveni = config.get("planovac", {})
    den = int(nastaveni.get("den_v_mesici", 2))
    cas = str(nastaveni.get("cas", "09:30"))
    if not re.fullmatch(r"\d{2}:\d{2}", cas):
        raise ValueError("planovac.cas musí mít formát HH:MM, např. 09:30")
    return _SABLONA_ULOHY.format(
        popis=popis_rozvrhu(obdobi, den, cas),
        cas=cas,
        rozvrh=_rozvrh(obdobi, den),
        cesta=escape(koren),
        spousteni=escape(spousteni),
    )

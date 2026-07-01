---
title: Broker catalog
description: People-search and background-check brokers Oblivion knows about — opt-out paths, sweep priority, and preview coverage.
---

# Broker catalog

Oblivion maintains a curated catalog of **70** people-search and background-check sites. This page lists every broker we can recognize, link opt-out flows for, and include in discovery sweeps.

**API:** `GET /api/brokers` returns the same catalog as JSON.

[User guide](/docs/user-guide/overview) · [Templates](/docs/user-guide/templates) · [Consumer API](/docs/developers/consumer-api)

---

## How discovery uses this catalog

| Stage | What runs | Scoring |
|-------|-----------|---------|
| **Landing preview** | Site-scoped search across up to 20 brokers per run (round-robin query budget) | Heuristic only; **likely** matches shown |
| **Full cleanup** | Broader sweep + profile URL patterns + pasted URLs + Venice when configured | Venice + heuristics; you confirm each match |

Preview does **not** query every catalog broker every time — search API query budgets limit how many `site:host` searches run per preview. Priority brokers (see table) are scheduled first.

**Tip:** If you already have a profile URL (e.g. FastBackgroundCheck `/people/name/id/…`), paste it on the landing form — Oblivion includes pasted URLs in full discovery even when preview search misses them.

---

## Catalog (70 brokers)

| Broker | Host | Tier | Automatable | Sweep priority | Preview sweep | Opt-out |
|--------|------|------|-------------|----------------|---------------|---------|
| Spokeo | spokeo.com | 1 | yes | yes | yes | [opt-out](https://www.spokeo.com/opt-out) |
| BeenVerified | beenverified.com | 1 | yes | yes | yes | [opt-out](https://www.beenverified.com/app/optout/search) |
| Whitepages | whitepages.com | 1 | yes | yes | yes | [opt-out](https://www.whitepages.com/suppression-requests) |
| Intelius | intelius.com | 1 | yes | yes | yes | [opt-out](https://www.intelius.com/opt-out) |
| TruthFinder | truthfinder.com | 1 | yes | yes | yes | [opt-out](https://www.truthfinder.com/opt-out/) |
| Instant Checkmate | instantcheckmate.com | 1 | yes | yes | yes | [opt-out](https://www.instantcheckmate.com/opt-out/) |
| MyLife | mylife.com | 2 | no |  |  | [opt-out](https://www.mylife.com/ccpa/index.pubview) |
| Radaris | radaris.com | 1 | yes | yes | yes | [opt-out](https://radaris.com/control/privacy) |
| FastBackgroundCheck | fastbackgroundcheck.com | 1 | yes | yes | yes | [opt-out](https://www.fastbackgroundcheck.com/optout) |
| ThatsThem | thatsthem.com | 1 | yes | yes | yes | [opt-out](https://thatsthem.com/optout) |
| AnyWho | anywho.com | 1 | yes |  |  | [opt-out](https://www.anywho.com/contact) |
| RocketReach | rocketreach.co | 1 | yes |  |  | [opt-out](https://rocketreach.co/privacy) |
| Nuwber | nuwber.com | 1 | yes | yes | yes | [opt-out](https://nuwber.com/removal/link) |
| TruePeopleSearch | truepeoplesearch.com | 1 | yes | yes | yes | [opt-out](https://www.truepeoplesearch.com/removal) |
| FastPeopleSearch | fastpeoplesearch.com | 1 | yes | yes | yes | [opt-out](https://www.fastpeoplesearch.com/removal) |
| USPhonebook | usphonebook.com | 1 | yes | yes | yes | [opt-out](https://www.usphonebook.com/opt-out) |
| ClustrMaps | clustrmaps.com | 1 | yes |  |  | [opt-out](https://clustrmaps.com/bl/opt-out) |
| PeekYou | peekyou.com | 1 | yes | yes | yes | [opt-out](https://www.peekyou.com/about/contact/optout) |
| ZabaSearch | zabasearch.com | 1 | yes | yes | yes | [opt-out](https://www.zabasearch.com/block_records/) |
| Addresses.com | addresses.com | 1 | yes |  |  | [opt-out](https://www.addresses.com/optout.php) |
| PeopleFinders | peoplefinders.com | 1 | yes | yes | yes | [opt-out](https://www.peoplefinders.com/opt-out) |
| PeopleLooker | peoplelooker.com | 1 | yes |  |  | [opt-out](https://www.peoplelooker.com/opt-out) |
| CheckPeople | checkpeople.com | 1 | yes | yes | yes | [opt-out](https://www.checkpeople.com/opt-out) |
| SearchPeopleFree | searchpeoplefree.com | 1 | yes |  |  | [opt-out](https://www.searchpeoplefree.com/opt-out) |
| FamilyTreeNow | familytreenow.com | 1 | yes | yes | yes | [opt-out](https://www.familytreenow.com/optout) |
| CyberBackgroundChecks | cyberbackgroundchecks.com | 1 | yes | yes |  | [opt-out](https://www.cyberbackgroundchecks.com/removal) |
| Verecor | verecor.com | 1 | yes |  |  | [opt-out](https://verecor.com/ng/control/privacy) |
| NeighborWho | neighborwho.com | 1 | yes | yes |  | [opt-out](https://www.neighborwho.com/opt-out/) |
| InfoTracer | infotracer.com | 1 | yes |  |  | [opt-out](https://infotracer.com/optout/) |
| GoLookup | golookup.com | 1 | yes |  |  | [opt-out](https://golookup.com/support/optout) |
| IDTrue | idtrue.com | 1 | yes |  |  | [opt-out](https://www.idtrue.com/optout/) |
| Persopo | persopo.com | 1 | yes |  |  | [opt-out](https://persopo.com/optout) |
| PublicRecordsNow | publicrecordsnow.com | 1 | yes |  |  | [opt-out](https://www.publicrecordsnow.com/opt-out) |
| SmartBackgroundChecks | smartbackgroundchecks.com | 1 | yes | yes | yes | [opt-out](https://www.smartbackgroundchecks.com/optout) |
| SpyFly | spyfly.com | 1 | yes |  |  | [opt-out](https://www.spyfly.com/help-center/opt-out) |
| US Search | ussearch.com | 1 | yes | yes |  | [opt-out](https://www.ussearch.com/opt-out/submit/) |
| VeriPages | veripages.com | 1 | yes | yes |  | [opt-out](https://veripages.com/remove) |
| Centeda | centeda.com | 1 | yes |  |  | [opt-out](https://centeda.com/remove) |
| United States Phonebook | unitedstatesphonebook.com | 1 | yes |  |  | [opt-out](https://www.unitedstatesphonebook.com/opt-out) |
| PublicDataCheck | publicdatacheck.com | 1 | yes |  |  | [opt-out](https://www.publicdatacheck.com/opt-out) |
| RecordsFinderUSA | recordsfinderusa.com | 1 | yes |  |  | [opt-out](https://recordsfinderusa.com/optout/) |
| SearchQuarry | searchquarry.com | 1 | yes |  |  | [opt-out](https://www.searchquarry.com/opt-out/) |
| BackgroundChecks.org | backgroundchecks.org | 1 | yes |  |  | [opt-out](https://www.backgroundchecks.org/opt-out/) |
| OfficialUSA | officialusa.com | 1 | yes |  |  | [opt-out](https://www.officialusa.com/opt-out/) |
| PeopleByName | peoplebyname.com | 1 | yes |  |  | [opt-out](https://www.peoplebyname.com/remove/) |
| PrivateEye | privateeye.com | 2 | no |  |  | [opt-out](https://www.privateeye.com/static/view/optout/) |
| ZoomInfo | zoominfo.com | 2 | no |  |  | [opt-out](https://www.zoominfo.com/privacy-center) |
| Acxiom | acxiom.com | 2 | no |  |  | [opt-out](https://isapps.acxiom.com/optout/optout.aspx) |
| LexisNexis | lexisnexis.com | 2 | no |  |  | [opt-out](https://optout.lexisnexis.com/) |
| ContactOut | contactout.com | 1 | yes |  |  | [opt-out](https://contactout.com/optout) |
| NumLookup | numlookup.com | 1 | yes |  |  | [opt-out](https://www.numlookup.com/opt-out) |
| Yasni | yasni.com | 1 | yes |  |  | [opt-out](https://www.yasni.com/optout.php) |
| PublicSearcher | publicsearcher.com | 1 | yes |  |  | [opt-out](https://www.publicsearcher.com/opt-out) |
| FindPeopleSearch | findpeoplesearch.com | 1 | yes |  |  | [opt-out](https://www.findpeoplesearch.com/opt-out) |
| CourtRecords.org | courtrecords.org | 1 | yes |  |  | [opt-out](https://www.courtrecords.org/opt-out/) |
| ReversePhoneLookup | reversephonelookup.com | 1 | yes |  |  | [opt-out](https://www.reversephonelookup.com/opt-out) |
| AdvancedBackgroundChecks | advancedbackgroundchecks.com | 1 | yes | yes | yes | [opt-out](https://www.advancedbackgroundchecks.com/removal) |
| GladIKnow | gladiknow.com | 1 | yes |  |  | [opt-out](https://gladiknow.com/optout) |
| PeopleWhiz | peoplewhiz.com | 1 | yes |  |  | [opt-out](https://www.peoplewhiz.com/optout) |
| USA People Search | usa-people-search.com | 1 | yes |  |  | [opt-out](https://www.usa-people-search.com/opt-out) |
| FreePeopleDirectory | freepeopledirectory.com | 1 | yes |  |  | [opt-out](https://www.freepeopledirectory.com/optout.php) |
| TelephoneDirectories.us | telephonedirectories.us | 1 | yes |  |  | [opt-out](https://www.telephonedirectories.us/OptOut.aspx) |
| StateRecords.org | staterecords.org | 1 | yes |  |  | [opt-out](https://staterecords.org/optout) |
| PublicRecords.com | publicrecords.com | 1 | yes |  |  | [opt-out](https://www.publicrecords.com/optout/) |
| ProfileEngine | profileengine.com | 1 | yes |  |  | [opt-out](https://profileengine.com/optout) |
| Reunion.com | reunion.com | 1 | yes |  |  | [opt-out](https://www.reunion.com/optout) |
| PeopleByPhone | peoplebyphone.com | 1 | yes |  |  | [opt-out](https://www.peoplebyphone.com/optout) |
| PhoneOwner | phoneowner.com | 1 | yes |  |  | [opt-out](https://www.phoneowner.com/optout) |
| ReversePhoneCheck | reversephonecheck.com | 1 | yes |  |  | [opt-out](https://www.reversephonecheck.com/opt-out) |
| GovernmentRegistry.org | governmentregistry.org | 1 | yes |  |  | [opt-out](https://www.governmentregistry.org/optout) |

---

## Priority sweep order

These brokers are queried first when building site-scoped searches:

- `spokeo`
- `beenverified`
- `truepeoplesearch`
- `fastpeoplesearch`
- `fastbackgroundcheck`
- `smartbackgroundchecks`
- `advancedbackgroundchecks`
- `checkpeople`
- `whitepages`
- `intelius`
- `truthfinder`
- `instantcheckmate`
- `radaris`
- `peekyou`
- `zabasearch`
- `peoplefinders`
- `nuwber`
- `thatsthem`
- `usphonebook`
- `familytreenow`
- `cyberbackgroundchecks`
- `neighborwho`
- `ussearch`
- `veripages`

---

*Broker table is generated from the server catalog when maintainers sync documentation.*

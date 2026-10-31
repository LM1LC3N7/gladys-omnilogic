// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature and option names, the status of
// the integration, the answers of the button and the command errors.
// -----------------------------------------------------------------------------

import { KINDS, STATUS_ROLE, TIMINGS } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** Two texts, one after the other, in both languages. */
export const join = (a, b) => both(`${a.en} ${b.en}`, `${a.fr} ${b.fr}`);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

const decimal = (value, language) =>
  language === 'en' ? String(value) : String(value).replace('.', ',');

export const FEATURE_NAMES = {
  [STATUS_ROLE]: both('Status', 'État'),
  [KINDS.ONOFF]: both('On / off', 'Marche / arrêt'),
  [KINDS.AIR_TEMP]: both('Air temperature', "Température de l'air"),
  [KINDS.WATER_TEMP]: both('Water temperature', "Température de l'eau"),
  [KINDS.HEATER]: both('Heating', 'Chauffage'),
  [KINDS.SETPOINT]: both('Heating set point', 'Consigne de chauffage'),
  [KINDS.HEATING]: both('Heating now', 'Chauffe en cours'),
  [KINDS.SPEED]: both('Speed (%)', 'Vitesse (%)'),
  [KINDS.POWER]: both('Power', 'Puissance'),
  [KINDS.SALT]: both('Salt (ppm)', 'Sel (ppm)'),
  [KINDS.PH]: both('pH', 'pH'),
  [KINDS.ORP]: both('ORP', 'Redox (ORP)'),
};

/** The names of objects without a name of their own, by kind. */
export const OBJECT_NAMES = {
  BACKYARD: both('Backyard', 'Extérieur'),
  BODY: both('Body of water', 'Bassin'),
  HEATER: both('Heater', 'Chauffage'),
  FILTER: both('Filter pump', 'Pompe de filtration'),
  PUMP: both('Pump', 'Pompe'),
  RELAY: both('Relay', 'Relais'),
  LIGHT: both('Light', 'Éclairage'),
  CHLOR: both('Chlorinator', 'Électrolyseur'),
  CSAD: both('Chemistry', 'Chimie'),
};

export const SELECT_LABELS = {
  off: both('Off', 'Arrêt'),
  on: both('On', 'Marche'),
};

export const STATE_TEXTS = {
  online: both('Connected', 'Connecté'),
  offline: both('Controller unreachable', 'Contrôleur injoignable'),
};

/** What a stop writes, for the status and the logs. */
const STOP_WHAT = {
  STATUS: both('off', 'arrêt'),
  ENABLE: both('heating off', 'chauffage arrêté'),
};

/** The status of the configuration screen. */
export const T = {
  noHost: both(
    'Enter the IP address of the OmniLogic controller, then save.',
    "Saisissez l'adresse IP du contrôleur OmniLogic, puis enregistrez.",
  ),
  invalidHost: (text) =>
    both(
      `"${text}" is not an IPv4 address nor a host name.`,
      `« ${text} » n'est ni une adresse IPv4 ni un nom d'hôte.`,
    ),
  configUnreadable: both(
    'The configuration cannot be read from Gladys: tried again every 30 s.',
    'La configuration ne peut pas être lue depuis Gladys : nouvel essai toutes les 30 s.',
  ),
  connecting: both('Connecting to the controller...', 'Connexion au contrôleur...'),
  unreachable: (address, wait) =>
    both(
      `The controller does not answer at ${address} (UDP): next try in ${wait.en}.`,
      `Le contrôleur ne répond pas à ${address} (UDP) : nouvel essai dans ${wait.fr}.`,
    ),
  failing: (reason, wait) =>
    both(
      `Reading the controller failed (${reason}): next try in ${wait.en}.`,
      `La lecture du contrôleur a échoué (${reason}) : nouvel essai dans ${wait.fr}.`,
    ),
  notPanel: both(
    'The device at this address does not answer like an OmniLogic controller (no configuration or telemetry).',
    "L'appareil à cette adresse ne répond pas comme un contrôleur OmniLogic (pas de configuration ni de télémétrie).",
  ),
  summary: ({ name, equipment, service }) =>
    both(
      `${name}: ${equipment} equipment read${service ? ', controller in service mode (commands refused, stops sent)' : ''}.`,
      `${name} : ${equipment} équipement(s) lu(s)${service ? ', contrôleur en mode service (commandes refusées, arrêts envoyés)' : ''}.`,
    ),
  connected: (summary) => both(`Connected. ${summary.en}`, `Connecté. ${summary.fr}`),
  commandsOff: (off) =>
    both(
      `Not allowed from Gladys: ${off.map((o) => o.en).join(', ')} (turning off always works).`,
      `Non autorisé depuis Gladys : ${off.map((o) => o.fr).join(', ')} (l'arrêt fonctionne toujours).`,
    ),
  optionEquipment: both('pumps and relays', 'pompes et relais'),
  optionLights: both('lights', 'éclairages'),
  optionHeating: both('heating', 'chauffage'),
  heldNote: (name) =>
    both(
      `${name}: the set point held by the controller is above what Gladys may write; turning heating (or its filter pump) on is refused until it is lowered.`,
      `${name} : la consigne gardée par le contrôleur dépasse ce que Gladys peut écrire ; la mise en marche du chauffage (ou de sa pompe de filtration) est refusée tant qu'elle n'est pas baissée.`,
    ),
  otherPanel: (names) =>
    both(
      `Another controller answers at this address: ${names} no longer read.`,
      `Un autre contrôleur répond à cette adresse : ${names} n'est plus lu.`,
    ),
  stopState: (name, attr, state) => {
    const what = STOP_WHAT[attr] ?? STOP_WHAT.STATUS;
    const states = {
      notSent: both('not sent yet, tried again', 'pas encore envoyé, réessayé'),
      noAck: both(
        'sent, no ack from the controller yet: written again every 15 s',
        'envoyé, pas encore acquitté par le contrôleur : réécrit toutes les 15 s',
      ),
      waiting: both('sent, waiting for the read back', 'envoyé, en attente de relecture'),
      coolDown: both(
        'shown off, still running down (cool-down): watched',
        'affiché arrêté, encore en fin de marche (refroidissement) : surveillé',
      ),
      heatUnknown: both(
        'heating shown off, the state of the heaters cannot be read: check on the controller',
        "chauffage affiché arrêté, l'état des réchauffeurs est illisible : vérifiez sur le contrôleur",
      ),
      stillHeating: both(
        'shown off, but still running: check on the controller',
        'affiché arrêté, mais encore en marche : vérifiez sur le contrôleur',
      ),
      held: both(
        `written ${TIMINGS.stopResends + 1} times without effect: held, no more writes until a new click or the controller shows it`,
        `écrit ${TIMINGS.stopResends + 1} fois sans effet : tenu, plus d'écriture avant un nouveau clic ou que le contrôleur l'affiche`,
      ),
      watch: both('applied, watched for a late command', 'appliqué, surveillé (commande tardive)'),
    };
    const s = states[state] ?? states.waiting;
    return both(
      `Stop (${what.en}) of ${name}: ${s.en}.`,
      `Arrêt (${what.fr}) de ${name} : ${s.fr}.`,
    );
  },
  test: {
    notSooner: (wait) =>
      both(
        `(Not read again: the next read is in ${wait.en}, never sooner than the interval.)`,
        `(Pas relu : la prochaine lecture est dans ${wait.fr}, jamais avant l'intervalle.)`,
      ),
  },
};

/** The answers of refused or uncertain commands (shown in Gladys, logged). */
export const ERRORS = {
  readOnly: both(
    'This feature takes no command.',
    'Cette fonctionnalité ne prend aucune commande.',
  ),
  badValue: both('Invalid value for this feature.', 'Valeur invalide pour cette fonctionnalité.'),
  disabled: (option) =>
    both(
      `Commands of ${option.en} are not allowed (configuration of the integration). Turning off always works.`,
      `Les commandes de ${option.fr} ne sont pas autorisées (configuration de l'intégration). L'arrêt fonctionne toujours.`,
    ),
  wouldHeat: both(
    'Turning this filter pump on may start the heating of its body (heater not seen off): heating must be allowed too.',
    'La mise en marche de cette pompe de filtration peut lancer le chauffage de son bassin (chauffage pas vu arrêté) : le chauffage doit aussi être autorisé.',
  ),
  noAddress: both(
    'No controller address known: nothing sent yet; kept, sent first as soon as an address is known.',
    "Aucune adresse de contrôleur connue : rien envoyé pour le moment ; gardé, envoyé en premier dès qu'une adresse est connue.",
  ),
  panelNotRead: both(
    'The controller is not read yet (its configuration is unknown): nothing sent.',
    "Le contrôleur n'est pas encore lu (sa configuration est inconnue) : rien envoyé.",
  ),
  notReadYet: both(
    'The configuration is not read yet: nothing sent.',
    "La configuration n'est pas encore lue : rien envoyé.",
  ),
  unknownPanel: both(
    'The controller of this feature is not the one read: nothing sent.',
    "Le contrôleur de cette fonctionnalité n'est pas celui qui est lu : rien envoyé.",
  ),
  otherPanel: both(
    'Another controller answers at this address, or its configuration changed: nothing sent; the controller and its configuration are read again in 5 s.',
    'Un autre contrôleur répond à cette adresse, ou sa configuration a changé : rien envoyé ; le contrôleur et sa configuration sont relus dans 5 s.',
  ),
  unknownObject: both(
    'The controller does not show this equipment: nothing sent.',
    "Le contrôleur n'affiche pas cet équipement : rien envoyé.",
  ),
  serviceMode: both(
    'The controller is in service or configuration mode: nothing sent (turning off still works).',
    "Le contrôleur est en mode service ou configuration : rien envoyé (l'arrêt fonctionne toujours).",
  ),
  unknownState: (reason) =>
    both(
      `The state of the controller cannot be read (${reason}): nothing sent.`,
      `L'état du contrôleur ne peut pas être lu (${reason}) : rien envoyé.`,
    ),
  unknownLimits: both(
    'The set point limits of this heater cannot be read: nothing sent.',
    'Les limites de consigne de ce chauffage ne peuvent pas être lues : rien envoyé.',
  ),
  outOfBounds: (low, high) =>
    both(
      `Set point out of bounds: ${decimal(low, 'en')} to ${decimal(high, 'en')} °C. Nothing sent.`,
      `Consigne hors bornes : ${decimal(low, 'fr')} à ${decimal(high, 'fr')} °C. Rien envoyé.`,
    ),
  heldUnreadable: both(
    'The set point held by this heater (or its limits) cannot be read: turning heating on would resume it unchecked. Nothing sent.',
    'La consigne gardée par ce chauffage (ou ses limites) ne peut pas être lue : la mise en marche la reprendrait sans contrôle. Rien envoyé.',
  ),
  heldAbove: (held, ceiling) =>
    both(
      `The heater holds a set point of ${decimal(held, 'en')} °C, above the ${decimal(ceiling, 'en')} °C Gladys may write: lower the set point first. Nothing sent.`,
      `Le chauffage garde une consigne de ${decimal(held, 'fr')} °C, au-dessus des ${decimal(ceiling, 'fr')} °C que Gladys peut écrire : baissez d'abord la consigne. Rien envoyé.`,
    ),
  firePit: both(
    'A fire pit is never lit from Gladys: nothing sent (turning it off works).',
    "Un foyer n'est jamais allumé depuis Gladys : rien envoyé (l'extinction fonctionne).",
  ),
  stopInProgress: both(
    'A heating stop of this body is in progress (not seen applied): nothing sent.',
    'Un arrêt du chauffage de ce bassin est en cours (pas encore vu appliqué) : rien envoyé.',
  ),
  stopMeanwhile: both(
    'A stop was clicked meanwhile: this command was not sent.',
    "Un arrêt a été cliqué entre-temps : cette commande n'a pas été envoyée.",
  ),
  replaced: both(
    'A newer command for the same setting replaced it: not sent.',
    'Une commande plus récente du même réglage la remplace : non envoyée.',
  ),
  tooSlow: both(
    'The controller did not give its turn in time: nothing sent.',
    "Le contrôleur n'a pas donné son tour à temps : rien envoyé.",
  ),
  sentUnconfirmed: (reason) =>
    both(
      `Sent, without confirmation (${reason}): the controller is read again in 5 s.`,
      `Envoyé, sans confirmation (${reason}) : le contrôleur est relu dans 5 s.`,
    ),
  notApplied: both(
    'Sent, not applied yet: the controller still shows the state before. Read again in 5 s.',
    "Envoyé, pas encore appliqué : le contrôleur montre encore l'état d'avant. Relu dans 5 s.",
  ),
  sentDiffers: both(
    'Sent, but the controller shows another value: read again in 5 s.',
    'Envoyé, mais le contrôleur affiche une autre valeur : relu dans 5 s.',
  ),
  stopNotSent: (reason) =>
    both(
      `Stop not sent yet (${reason}): kept, tried again every 15 s and at each read.`,
      `Arrêt pas encore envoyé (${reason}) : gardé, réessayé toutes les 15 s et à chaque lecture.`,
    ),
  stopUnconfirmed: both(
    'Stop sent, without confirmation yet: kept and checked every 15 s.',
    'Arrêt envoyé, sans confirmation pour le moment : gardé et vérifié toutes les 15 s.',
  ),
  stopStillRunning: both(
    'Stop written and shown by the controller, but still running down (cool-down, a heater still on): watched.',
    'Arrêt écrit et affiché par le contrôleur, mais encore en fin de marche (refroidissement, réchauffeur encore allumé) : surveillé.',
  ),
  stopNotApplied: both(
    'Stop sent, not applied yet: kept, checked every 15 s and written again 15 s after each write (3 times at most).',
    'Arrêt envoyé, pas encore appliqué : gardé, vérifié toutes les 15 s et réécrit 15 s après chaque écriture (3 fois au plus).',
  ),
};

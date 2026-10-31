# Hayward OmniLogic pour Gladys

Affiche votre contrôleur de piscine **Hayward OmniLogic** dans Gladys par
son **protocole local** (UDP, port 10444) : sans cloud, sans compte,
directement sur votre réseau.

> **Jamais testé avec un vrai contrôleur.** Sans lien avec Hayward.
> L'intégration suit la bibliothèque python-omnilogic-local (Apache-2.0) et
> les captures de vrais contrôleurs qu'elle publie. Une mise à jour du
> micrologiciel du contrôleur peut changer le protocole. Le cloud Hayward
> (compte de l'application OmniLogic) n'est pas utilisé.

## Ce que vous obtenez

Un appareil par contrôleur, avec, pour chaque équipement que montre sa
configuration :

| Équipement             | Fonctionnalités                                              |
| ---------------------- | ------------------------------------------------------------ |
| Extérieur              | Température de l'air                                         |
| Bassin (piscine, spa)  | Température de l'eau                                         |
| Chauffage d'un bassin  | Chauffage (liste marche / arrêt), consigne, chauffe en cours |
| Pompe de filtration    | Marche / arrêt (liste), vitesse (%), puissance (W)           |
| Autre pompe            | Marche / arrêt (liste), vitesse (%)                          |
| Relais (pas une vanne) | Marche / arrêt (liste)                                       |
| Éclairage ColorLogic   | Marche / arrêt (liste)                                       |
| Électrolyseur au sel   | Sel (ppm, moyenne)                                           |
| pH / redox (CSAD)      | pH, redox (mV)                                               |

Plus une fonctionnalité **État** (connecté ou injoignable). Les vannes
motorisées, les groupes (thèmes), les spectacles de lumière, les vitesses
des pompes, les réglages de l'électrolyseur, le débordement et les
programmations ne sont pas affichés dans cette version.

- Le protocole parle en °F quelle que soit l'unité d'affichage du
  contrôleur : chaque température est convertie exactement en °C
  ((°F − 32) × 5 / 9). Un capteur configuré dans une autre unité n'est pas
  publié.
- Une température d'eau de −1 (pas de débit, pas de sonde), un sel ou un pH
  à 0, un état que l'intégration ne connaît pas : jamais publiés.
- Le volume d'un bassin (en gallons dans la configuration) n'est pas publié.

**Identité.** Le protocole ne donne ni numéro de série ni adresse MAC.
L'appareil est identifié par les numéros système et les types des bassins
du contrôleur (une empreinte), jamais par son adresse IP : il survit aux
redémarrages, aux mises à jour et aux changements de nom, mais ajouter ou
retirer un bassin dans la configuration du contrôleur crée un nouvel
appareil. Avant chaque commande (jamais avant un arrêt), l'intégration
vérifie que la télémétrie qu'elle vient de lire appartient à la
configuration qu'elle connaît (même somme de contrôle, mêmes bassins) ;
sinon rien n'est envoyé et la configuration est relue.

Lecture toutes les 30 secondes par défaut (de 15 s à 10 min, réglable) : la
télémétrie à chaque lecture, la configuration seulement au démarrage et
quand sa somme de contrôle change. Une requête à la fois, chacune sur une
nouvelle socket UDP.

## Installation

1. Donnez une adresse IP fixe au contrôleur dans votre box.
2. Dans Gladys, installez l'intégration et saisissez l'adresse IP du
   contrôleur (ou son nom d'hôte, éventuellement suivi d'un port).
3. Enregistrez, puis ajoutez le contrôleur depuis l'onglet **Découverte**.

Le contrôleur n'a pas d'identifiants : rien de secret n'est configuré.

## Arrêter (toujours possible)

Choisir **Arrêt** sur une pompe, un relais ou un éclairage, ou **Arrêt** sur
un chauffage, ne dépend d'aucune option, ni d'une lecture ou d'une commande
en cours (il les interrompt et part sur une nouvelle socket), ni d'une
lecture en échec, ni de l'identité du contrôleur, ni de la configuration :
juste après un redémarrage, il part vers l'adresse du dernier contrôleur lu
(gardée dans `/data`), et un arrêt pas encore vu appliqué avant un
redémarrage est renvoyé dès le démarrage du conteneur. Une commande arrivée
avant lui et pas encore partie est abandonnée.

Il réussit quand la télémétrie relue le montre : l'équipement arrêté, ou le
chauffage arrêté **et** aucun réchauffeur de son bassin encore allumé.
Sinon la réponse dit pourquoi, et l'arrêt est gardé (dans `/data`) et
vérifié toutes les 15 s (chaque adresse à part) et à chaque lecture :

- **aucune adresse connue** (pas de configuration, aucun contrôleur lu
  avant) : rien n'est envoyé pour le moment ; l'arrêt est gardé en mémoire
  et part en premier dès qu'une adresse est connue ;
- **pas d'acquittement du contrôleur** (3 s d'essais, toutes les 250 ms) :
  réécrit à chaque vérification (15 s), à chaque lecture qui atteint le
  contrôleur et quand vous cliquez sur **Tester la connexion** (le bouton ne
  réécrit que les arrêts jamais acquittés ; les autres gardent leurs 15 s) ;
  un arrêt que le contrôleur n'a jamais acquitté n'est jamais tenu ni
  abandonné ;
- **acquitté, pas appliqué** (la télémétrie ne le montre pas) : réécrit 15 s
  après chaque écriture, 3 fois au plus (écritures acquittées), puis tenu
  sans nouvelle écriture, ce que dit l'état de l'intégration ;
- **affiché arrêté mais encore en fin de marche** (une pompe de filtration
  en refroidissement ou en attente d'arrêt, un réchauffeur encore allumé) :
  surveillé, rien n'est réécrit ; après 10 minutes l'état vous demande de
  vérifier sur le contrôleur ; quand les réchauffeurs ne peuvent pas être
  lus (configuration pas encore lue), l'état le dit.

L'état de l'intégration dit où en est chaque arrêt. Quand le même
contrôleur répond à une nouvelle adresse, ses arrêts gardés le suivent.

Un arrêt gardé est abandonné quand le contrôleur le montre, ou quand une
commande du même réglage cliquée dans Gladys après lui (option activée) est
partie (acquittée, ou envoyée sans acquittement : elle a pu être appliquée).
Un nouveau clic sur Arrêt le réécrit et recompte ses écritures. Un arrêt
gardé dans `/data` avant un redémarrage est abandonné de même, sans être
envoyé, quand une telle commande de son réglage est partie depuis le
démarrage (un `/data` lent à lire est appliqué quand sa lecture se termine).
Jamais par le temps. Une commande partie moins de 30 s avant l'arrêt et
arrivée après lui est contrée par une nouvelle écriture. Tant que l'arrêt
du chauffage d'un bassin n'est pas vu appliqué, sa consigne et la mise en
marche de sa pompe de filtration sont refusées.

## Mettre en marche et chauffer (options)

Trois options, **désactivées par défaut** :

- **Autoriser la mise en marche des pompes et relais** : pompes de
  filtration (à leur dernière vitesse quand elle est dans leurs limites,
  sinon leur maximum, comme l'application Hayward), autres pompes et
  relais. Les vannes ne sont jamais commandées, et un relais de foyer
  (`RLY_FIREPIT`) n'est jamais allumé (l'extinction fonctionne). Mettre en
  marche une pompe de filtration dont le chauffage n'est pas vu arrêté
  (chauffage en marche, réchauffeur encore allumé, ou illisible) exige aussi
  l'option chauffage, et la consigne que garde ce chauffage doit être dans
  les bornes ci-dessous (sinon refus : baissez-la d'abord) : l'eau qui
  circule peut lancer la chauffe.
- **Autoriser l'allumage des éclairages** (éclairages ColorLogic, sur leur
  dernier spectacle).
- **Autoriser le chauffage** : mettre un chauffage en marche, régler sa
  consigne. La valeur écrite est un °F entier dans la plage du protocole
  (65–104 °F), dans les limites du chauffage lues dans sa configuration
  (jamais écrite quand elles sont illisibles), un **spa à 40 °C au plus**
  (104 °F), une piscine au plus au plafond de la configuration (35 °C par
  défaut, de 20 à 40 °C, converti en °F arrondi vers le bas). Mettre un
  chauffage en marche reprend la consigne que garde le contrôleur (laissée
  par l'application Hayward, l'écran ou une programmation) : c'est refusé
  quand cette consigne dépasse ces bornes ou ne peut pas être lue, et l'état
  de l'intégration le dit ; baissez d'abord la consigne.

Ce sont des listes et une consigne, jamais un interrupteur : un « tout
éteindre » ne les atteint jamais. Chaque commande relit la télémétrie juste
avant (identité, mode service, l'équipement), revérifie les options juste
avant son datagramme, part sous 3,5 s ou pas du tout, et ne réussit que si
la télémétrie relue montre la valeur demandée (« envoyé, pas encore
appliqué » sinon, puis relectures à 5 et 20 s). Les commandes arrivées
ensemble (une scène) partent l'une après l'autre dans un même tour. Aussi
refusées : avant la lecture de la configuration de l'intégration ou du
contrôleur, quand un autre contrôleur répond à l'adresse ou que sa
configuration a changé (tous deux relus 5 s plus tard), quand le contrôleur est en mode service ou
configuration, ou quand un arrêt a été cliqué entre-temps.

## Bon à savoir

- Arrêter une pompe de filtration laisse son chauffage activé, comme
  l'application Hayward : c'est le contrôleur qui coupe la chauffe sans
  débit (refroidissement, vitesse minimale du réchauffeur), et la chauffe
  reprend quand une programmation relance la pompe. Arrêtez aussi le
  chauffage pour cesser de chauffer.
- Un acquittement est attendu 1,5 s avant de renvoyer une requête (la
  référence attend 4 s) : sur un contrôleur plus lent, une scène de
  plusieurs réglages peut en laisser certains non envoyés (« rien envoyé »,
  jamais envoyés en retard).

- Le contrôleur n'est jamais lu avant l'intervalle : ni par le bouton
  **Tester la connexion**, ni par une Découverte, une reconnexion à Gladys
  ou un redémarrage (l'heure de la dernière lecture est gardée dans
  `/data`). Seules les relectures qui suivent une commande ou un clic sur
  Arrêt (5 et 20 s) et les vérifications d'un arrêt gardé (toutes les 15 s)
  font exception.
- Une valeur de plus de 2 minutes n'est jamais renvoyée comme nouvelle.
- Les réponses sont bornées : un datagramme de 64 Kio, une réponse de 1 Mio
  (4 Mio une fois décompressée), 256 blocs, 3 s entre deux blocs.
- L'application Hayward, l'écran du contrôleur et ses programmations
  peuvent aussi le commander : la dernière commande l'emporte.

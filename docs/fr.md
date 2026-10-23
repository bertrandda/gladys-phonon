# Phonon TTS

Phonon TTS donne à Gladys une voix **hors ligne** : les textes à prononcer
(annonces des scènes « Jouer une notification ») sont synthétisés sur votre
machine Gladys par les modèles [Phonon](https://huggingface.co/gradium) de
Gradium, sans service cloud ni abonnement. Une fois le modèle téléchargé,
aucune connexion Internet n'est nécessaire.

## Prérequis

- **Gladys 5.3 ou plus récent** (voix enfichables).
- **Gladys en mode réseau `host`** (installation standard) : les enceintes
  (Sonos, Google Cast, AirPlay…) téléchargent l'audio sur une adresse de votre
  réseau local.
- Environ **1 Go de mémoire** et **150 Mo de disque** libres pour le moteur
  vocal. Un Raspberry Pi 4 ou 5 convient.
- Pour les modèles **Phonon 40m** (toutes les langues) : un compte
  [Hugging Face](https://huggingface.co) gratuit.
  1. Ouvrez la page du modèle, par exemple
     [gradium/phonon-40m-fr](https://huggingface.co/gradium/phonon-40m-fr), et
     acceptez ses conditions d'utilisation (validation immédiate).
  2. Créez un token **en lecture** sur
     [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens).

  Le modèle **Phonon 31m** (anglais uniquement) ne demande pas de compte.

Les modèles Phonon 40m sont sous licence **CC BY-NC 4.0** (usage non
commercial) ; Phonon 31m et les voix du catalogue sont sous licence
Apache 2.0.

## Configuration

Juste après l'installation, l'intégration **ne parle pas** : aucun modèle n'est
choisi par défaut et rien n'est téléchargé.

1. Ouvrez l'onglet **Configuration** de l'intégration.
2. Choisissez le **modèle** : un modèle 40m dans votre langue (le meilleur
   choix), le modèle multilingue (choisissez alors sa **langue**), ou Phonon
   31m pour l'anglais sans compte.
3. Pour un modèle 40m, collez votre **token Hugging Face**. Il ne sert qu'au
   téléchargement et n'est jamais transmis au moteur vocal.
4. Choisissez la **voix** : la voix du modèle, ou l'une des 102 voix du
   catalogue Phonon. Écoutez-les d'abord sur la
   [page de démonstration des voix](https://bertrandda.github.io/gladys-phonon/),
   qui indique le nom exact à choisir dans la liste. Toutes les voix
   fonctionnent avec tous les modèles, mais sonnent mieux dans leur langue.
5. Enregistrez. L'état en haut de l'écran suit le téléchargement (environ
   75 Mo), puis le démarrage du moteur, jusqu'à **Prêt**.
6. Faites de Phonon TTS la voix de Gladys : **Intégrations › Intelligence
   artificielle › Voix**, choisissez **Phonon TTS**.

Vos scènes « Jouer une notification » parlent désormais avec Phonon.

Seuls le modèle et la voix sélectionnés sont gardés sur le disque : changer de
modèle ou de voix supprime les précédents. Pendant le téléchargement d'un
nouveau modèle, la voix actuelle continue de parler.

### Voix personnalisée (Gradium Studio)

Une voix créée ou clonée dans [Gradium Studio](https://studio.gradium.ai/)
fonctionne aussi :

1. Créez une clé API dans Gradium Studio et collez-la dans **Clé API Gradium**,
   puis enregistrez.
2. Lancez l'action **Lister mes voix Gradium Studio** : elle affiche
   l'identifiant de chacune de vos voix.
3. Choisissez **Voix personnalisée** dans la liste des voix, collez
   l'identifiant dans **Voix personnalisée** et enregistrez.

Vous pouvez aussi y indiquer l'URL https d'un fichier de voix Phonon
(`.safetensors`). La voix n'est téléchargée qu'une fois.

### Réglages avancés

- **Débit de parole** : plus lent, normal ou plus rapide.
- **Poids du modèle** : `q8` (recommandé) est plus léger et plus rapide sur un
  processeur ; `f32` est plus lourd et plus lent.

## Actions

- **Tester la voix** : synthétise une phrase (la vôtre, ou une phrase
  d'exemple) et indique la durée de parole générée et le temps de calcul.
- **Lister mes voix Gradium Studio** : voir ci-dessus.
- **Relancer le moteur vocal** : relance le téléchargement et redémarre le
  moteur, par exemple après une coupure réseau.

## Limites

- **L'assistant vocal répond en texte** avec Phonon TTS : sa page est en HTTPS,
  et le navigateur refuse de lire l'audio servi en HTTP sur le réseau local.
  Les annonces des scènes, elles, parlent normalement.
- Gladys attend une synthèse **30 secondes** au plus. Sur une machine modeste,
  un texte très long est coupé et seul son début est prononcé.
- Une seule langue par modèle (celle du modèle, ou celle choisie pour le
  multilingue) : un texte dans une autre langue est lu avec l'accent du
  modèle.

## Dépannage

- **« Aucun modèle sélectionné »** : choisissez un modèle et enregistrez.
- **« Modèle à accès restreint » / « Accès refusé »** : acceptez les
  conditions sur la page Hugging Face du modèle **avec le compte du token**,
  vérifiez le token, puis enregistrez de nouveau.
- **« Impossible de joindre Hugging Face »** : Gladys a besoin d'Internet pour
  le premier téléchargement. Vérifiez la connexion, puis lancez **Relancer le
  moteur vocal**.
- **Le moteur s'arrête au démarrage** : consultez les journaux du conteneur
  `phonon` dans le bloc Supervision (mémoire insuffisante, processeur non
  pris en charge…).
- **Les enceintes ne jouent rien** : vérifiez que Gladys tourne en mode
  réseau `host` et que Phonon TTS est bien la voix choisie dans
  Intégrations › Intelligence artificielle.
- Les journaux de l'intégration (bloc Supervision) détaillent chaque étape.

Signalez un problème sur
[github.com/bertrandda/gladys-phonon](https://github.com/bertrandda/gladys-phonon/issues).

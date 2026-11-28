/**
 * Application de l'état des fonctionnalités à l'API locale (Marketplace,
 * ticket #30, PR 2).
 *
 * 1. Contrôle des routes. Une route d'une fonctionnalité éteinte répond
 *    `403 { error, code: 'FEATURE_DISABLED', feature }`, quel que soit le
 *    routeur qui la sert. Le contrôle est posé une seule fois dans server.js,
 *    juste après requireApiToken et avant l'analyse des corps : une requête
 *    refusée ne coûte qu'une lecture de la table `features`.
 *
 *    Le ticket prévoyait `exigerFonction(id)` au montage de chaque routeur.
 *    Quatre routeurs mélangent des fonctionnalités (wa.js sert le noyau, crm,
 *    notes-vocales et analyses ; settings_and_agents.js et ai.js le noyau et
 *    agents ; cliBridge.js mcp-externe et agents-cli-locaux) : la
 *    fonctionnalité d'une requête se lit donc dans le catalogue, route par
 *    route. Le test d'inventaire (featuresCatalogue.test.js) garantit que
 *    toute route du code y figure ; le test d'application
 *    (featuresApplication.test.js), que chacune est refusée sur le vrai
 *    serveur quand sa fonctionnalité est éteinte.
 *
 *    La correspondance reproduit celle d'Express 5 avec ses options par
 *    défaut, pour qu'aucune variante d'écriture ne passe à côté :
 *    - insensible à la casse ;
 *    - barre oblique finale facultative ;
 *    - HEAD servi par les routes GET ;
 *    - `:param` couvre un segment entier, sans « / ».
 *
 * 2. Routeurs chargés à la demande (règle 5.2 de l'étude : une fonctionnalité
 *    éteinte ne coûte rien). `routeurParesseux` ne requiert le routeur qu'à la
 *    première requête qui a passé le contrôle, donc seulement si la
 *    fonctionnalité est active. Réservé aux routeurs d'une seule
 *    fonctionnalité.
 */
const features = require('./features');
const { fonctionnalites } = require('./featuresCatalogue');

const echapper = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ROUTES = fonctionnalites.flatMap((f) => f.surfaces.api.map((entree) => {
    const [methode, chemin] = entree.split(' ');
    const motif = chemin.split('/')
        .map((segment) => (segment.startsWith(':') ? '[^/]+' : echapper(segment)))
        .join('/');
    return { feature: f.id, noyau: f.noyau, methode, regex: new RegExp(`^${motif}/?$`, 'i') };
}));

/**
 * @param {string} methode méthode HTTP (en majuscules, comme req.method)
 * @param {string} chemin chemin sans la chaîne de requête (req.path)
 * @returns {string|null} l'id de la fonctionnalité, ou null si aucune route
 *          du catalogue ne correspond (la requête finira en 404)
 */
function fonctionnaliteDeRequete(methode, chemin) {
    const m = methode === 'HEAD' ? 'GET' : methode;
    const route = ROUTES.find((r) => r.methode === m && r.regex.test(chemin));
    return route ? route.feature : null;
}

const NOYAU = new Set(fonctionnalites.filter((f) => f.noyau).map((f) => f.id));

/**
 * Intergiciel Express : refuse une route dont la fonctionnalité est éteinte.
 * Une erreur de lecture de l'état est transmise à Express (500) : le
 * gestionnaire de la route ne s'exécute pas.
 */
async function controleFonctionnalites(req, res, next) {
    const feature = fonctionnaliteDeRequete(req.method, req.path);
    if (!feature || NOYAU.has(feature)) return next();
    if (await features.estActive(feature)) return next();
    return res.status(403).json({
        error: `La fonctionnalité « ${feature} » est désactivée.`,
        code: 'FEATURE_DISABLED',
        feature
    });
}

const routeursCharges = new Set();

/**
 * @param {string} feature fonctionnalité servie par le routeur (journal)
 * @param {() => Function} charger requiert et renvoie le routeur
 * @returns {Function} intergiciel qui charge le routeur à la première requête
 */
function routeurParesseux(feature, charger) {
    let routeur = null;
    return (req, res, next) => {
        if (!routeur) {
            routeur = charger();
            routeursCharges.add(feature);
            // stderr : le CLI et le MCP réservent stdout à leur protocole.
            console.error(`[Marketplace] Routeur de « ${feature} » chargé à la demande.`);
        }
        return routeur(req, res, next);
    };
}

module.exports = {
    controleFonctionnalites,
    fonctionnaliteDeRequete,
    routeurParesseux,
    routeursCharges: () => new Set(routeursCharges),
};

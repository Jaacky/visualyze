var pgp = require("pg-promise")();
var config = require("./config.js")();

var cn = {
    host: config.db.host,
    port: config.db.port,
    database: config.db.name,
};

var db = pgp(cn);

/*
    Returns a user
*/
const getUser = function(email, cb) {

    var userQString = "SELECT * FROM users WHERE email = $1";
    var graphsQString = "SELECT * FROM graphs WHERE owner = $1";
    var fusionsQString = "SELECT * FROM "
                    + "(SELECT f.id, f.date_created, f.name, fto.owner "
                    + "FROM fusions as f, fusions_to_owners as fto "
                    + "WHERE f.id = fto.fusion_id) as myf "
                + "WHERE myf.owner=$1";
    var fusionInvitesQString = "SELECT * FROM fusion_invites WHERE requested=$1";
    var pendingFusionRequestsQString = "SELECT * FROM fusion_invites WHERE requester=$1";
    var pendingFriendRequestsQString = "SELECT * FROM friendship_requests WHERE requester=$1";
    var requestingYourFriendshipQString = "SELECT * FROM friendship_requests WHERE requested=$1";
    var friendsQString = "SELECT * FROM friendships WHERE user_a =$1";
    
    var findUser = new pgp.ParameterizedQuery(userQString);
    var findAllUserGraphs = new pgp.ParameterizedQuery(graphsQString);
    var findAllUserFusions = new pgp.ParameterizedQuery(fusionsQString);
    var findAllFusionInvites = new pgp.ParameterizedQuery(fusionInvitesQString);
    var findAllPendingFusionRequests = new pgp.ParameterizedQuery(pendingFusionRequestsQString); 
    var findAllPendingFriendRequests = new pgp.ParameterizedQuery(pendingFriendRequestsQString);
    var findAllRequestingYourFriendship = new pgp.ParameterizedQuery(requestingYourFriendshipQString);
    var findAllFriends = new pgp.ParameterizedQuery(friendsQString);

    db.task(function(t) {
        return t.batch([
            t.one(findUser, [email]), // 0
            t.any(findAllUserGraphs, [email]), // 1
            t.any(findAllUserFusions, [email]), // 2
            t.any(findAllFusionInvites, [email]), // 3
            t.any(findAllPendingFusionRequests, [email]), // 4
            t.any(findAllPendingFriendRequests, [email]), // 5
            t.any(findAllRequestingYourFriendship, [email]), // 6
            t.any(findAllFriends, [email]), // 7
        ]);
    })
        .then(function(result) {
            var user = result[0];
            var graphs = result[1];
            var fusions = result[2];
            
            user.fusion_requests = {
                invites: result[3],
                pending: result[4]
            };

            user.plots = {graphs, fusions};
            user.friends = {
                pending: result[5], 
                requesting: result[6], 
                accepted: result[7]
            };
            cb(user);
        })
        .catch(function(err) {
            console.log('Get user err', err);
            // -1 for passport to recognize that user does not exist (could extend further for more errs)
            cb(-1);
        });
}

/*
    Returns all of a user's graphs and fusions
*/
const getAllUserPlots = function(email, cb) {

    var graphQString = "SELECT * FROM graphs "
                + "WHERE owner = $1";

    var fusionQString = "SELECT * FROM "
                    + "(SELECT f.id, f.date_created, f.name, fto.owner "
                    + "FROM fusions as f, fusions_to_owners as fto "
                    + "WHERE f.id = fto.fusion_id) as myf "
                + "WHERE myf.owner=$1";

    var findAllUserGraphs = new pgp.ParameterizedQuery(graphQString);
    var findAllUserFusions = new pgp.ParameterizedQuery(fusionQString);

    db.task(function(t) {
        return t.batch([t.any(findAllUserGraphs, [email]), t.any(findAllUserFusions, [email])]);
    })
        .then(function(result) {
            var graphs = result[0];
            var fusions = result[1];
            cb({graphs, fusions});
        })
        .catch(function(err) {
            console.log("getAllPlots ", err);
        });
}

/*
    Returns a graph along with all its data points
*/
const getGraph = function(email, graph_id, cb) {

    var graphQString = "SELECT * FROM graphs "
                + "WHERE owner = $1 AND id = $2";
    
    var pointsQString = "SELECT graphs.colour, data_points.value, data_points.date "
                + "FROM graphs INNER JOIN data_points ON "
                + "graphs.id = data_points.graph AND graphs.owner = $1 AND graphs.id = $2";

    var findGraph = new pgp.ParameterizedQuery(graphQString);
    var findPoints = new pgp.ParameterizedQuery(pointsQString);
    
    db.task(function(t) {
        return t.batch([t.one(findGraph, [email, graph_id]), t.any(findPoints, [email, graph_id])]);
    })
        .then(function(result) {
            console.log(result);
            var graph = result[0];
            graph.points = result[1];
            cb(graph);
        })
        .catch(function(err) {
            console.log("TASK AND BATCH ", err);
        });
}

/*
    Returns an object { fusion, [graphs] }

    fusion is the fusion, identified by fusion_id, and its details
    [graphs] is an array of graphs that also contain their data points

    Uses helper function createFusionGraphsQ
*/
const getFusion = function(email, fusion_id, cb) {

    var getFusionQString = "SELECT * FROM fusions WHERE id = $1";
    var getGraphsInFusionQString =  "SELECT * FROM graphs "
            + "WHERE id IN "
                + "(SELECT graph_id "
                + "FROM fusions_to_graphs as ftg INNER JOIN graphs as g "
                + "ON ftg.fusion_id = g.id "
                + "WHERE ftg.fusion_id = $1)";
    var getUserGraphsQString = "SELECT * FROM graphs "
                + "WHERE owner = $1";
    
    var getFusion = new pgp.ParameterizedQuery(getFusionQString);
    var getGraphsInFusion = new pgp.ParameterizedQuery(getGraphsInFusionQString);
    var getUserGraphs = new pgp.ParameterizedQuery(getUserGraphsQString);

    db.tx(function(t) {
        /*
            In the batch:
                1st query retrieves the fusion details
                2nd query retrieves each graph that is in the fusion and its data points
        */
        return t.batch([
            t.one(getFusion, [fusion_id]), // 1st query
            t.any(getGraphsInFusion, [fusion_id]) // 2nd query
                .then(function(graphs) {
                    // After getting all the graph that belong in the fusion, query for all the graph details and their data points
                    return t.tx(function(t1) {
                        queries = [];
                        for (var i=0; i<graphs.length; i++) {
                            /*
                                Creating the queries for each graph to get their data points
                                > Uses a constructor function, createFusionGraphsQ, beacuse the graphs[i] that gets pushed
                                    becomes undefined if not function scoped after each iteration
                            */
                            queries.push(
                                createFusionGraphsQ(t1, [graphs[i].owner, graphs[i].id])
                            );
                        }
                        return t1.batch(queries);
                    });
                })
                .catch(function(err) {
                    console.log("level-t fusion err", err);
                }),
            t.any(getUserGraphs, [email])
        ]);
    })
        .then(function(result) {
            // formatting the result so that 1 object gets returned, the fusion and its attribute, .graph, contains all the graphs
            var fusion = result[0];
            fusion.graphs = result[1];
            var userGraphs = result[2];
            cb({ fusion, userGraphs });
        })
        .catch(function(err) {
            console.log("INIT TX GET FUSION ", err);
        });
}

/* 
    Inserting a point to a graph
*/
const addPoint = function(graph_id, value, date, cb) {
    
    var queryString = "INSERT INTO data_points(graph, value, date) "
                + "VALUES($1, $2, $3)";
    var insertPoint = new pgp.ParameterizedQuery(queryString);

    db.none(insertPoint, [graph_id, value, date])
        .then(function(data) {
            cb(data);
        })
        .catch(function(err) {
            console.log(err);
        });
}

const addGraph = function(owner, name, cb) {
    var insertString = "INSERT INTO graphs(owner, name) "
                + "VALUES($1, $2)";
    var insertGraph = new pgp.ParameterizedQuery(insertString);

    db.none(insertGraph, [owner, name])
        .then(function() {
            cb();
        })
        .catch(function(err) {
            console.log("Add graph err", err);
        });
}

const addFusion = function(owner, name, cb) {
    var insertFusionString = "INSERT INTO fusions(name) "
                    + "VALUES($1) RETURNING id";
    var insertFusionOwnerString = "INSERT INTO fusions_to_owners(fusion_id, owner) "
                    + "VALUES($1, $2)";

    var insertFusion = new pgp.ParameterizedQuery(insertFusionString);
    var insertFusionOwner = new pgp.ParameterizedQuery(insertFusionOwnerString);

    /* Might need to batch inserts */
    db.one(insertFusion, [name])
        .then(function(inserted) {
            db.none(insertFusionOwner, [inserted.id, owner])
                .then(function() {
                    cb();
                })
                .catch(function(err) {
                    console.log('Add fusion owner err', err);
                });
        })
        .catch(function(err) {
            console.log("Add fusion err", err);
        });
}

const addGraphsToFusion = function(fusion_id, graphs, cb) {
    var insertGraphToFusionQString = "INSERT INTO fusions_to_graphs(fusion_id, graph_id) "
                                + "VALUES($1, $2)";
    var insertGraphToFusion = new pgp.ParameterizedQuery(insertGraphToFusionQString);

    var queries = [];
    for (var i=0; i<graphs.length; i++) {
        queries.push(db.none(insertGraphToFusion, [fusion_id, graphs[i]]));
    }

    db.tx(function(t) {
        return t.batch(queries);
    })
        .then(function() {
            cb();
        })
        .catch(function(err) {
            console.log("Batch insert graphs to fusion err", err);
        });
}

const addFusionRequests = function(fusion_id, user, invitees, cb) {
    var insertFusionInviteRequestQString = "INSERT INTO fusion_invites(requester, requested, fusion_id) "
                                + "VALUES($1, $2, $3)";

    var insertIntoFusionInvites = pgp.ParameterizedQuery(insertFusionInviteRequestQString);

    queries = [];
    for (var i=0; i<invitees.length; i++) {
        queries.push(db.none(insertIntoFusionInvites, [user, invitees[i], fusion_id]));
    }

    db.tx(function(t) {
        return t.batch(queries);
    })
        .then(function() {
            cb();
        })
        .catch(function(err) {
            console.log("batch insert into fusion_invites err", err);
            cb(-1);
        });
}

const acceptFusionRequest = function(fusion_id, owner, cb) {
    var insertOwnerToFusionQString = "INSERT INTO fusions_to_owners(fusion_id, owner) "
                                + "VALUES($1, $2)";
    var insertOwnerToFusion = new pgp.ParameterizedQuery(insertOwnerToFusionQString);

    db.none(insertOwnerToFusion, [fusion_id, owner])
        .then(function() {
            cb();
        })
        .catch(function(err) {
            console.log("accept fusion req err", err);
            cb(-1);
        });
    // var queries = [];
    // for (var i=0; i < friends.length; i++) {
    //     queries.push(db.none(insertFriendsToFusion, [fusion_id, friends[i]]));
    // }

    // db.tx(function(t) {
    //     return t.batch(queries);
    // })
    //     .then(function() {
    //         cb();
    //     })
    //     .catch(function(err) {
    //         console.log("Batch add friend to fusion err", err);
    //         cb(-1);
    //     })
}

const graphsBeginWith = function(begin, cb) {
    var searchString = "SELECT * FROM graphs "
                + "WHERE name LIKE $1";
    
    var search = pgp.ParameterizedQuery(searchString);
    console.log(begin);
    db.any(search, [begin])
        .then(function(graphs) {
            console.log(graphs);
            cb(graphs);
        })
        .catch(function(err) {
            console.log("graphsBeginWith err", err);
        });
} 

const addFriendRequest = function(requester, requested, cb) {
    var insertString = "INSERT INTO friendship_requests(requester, requested) "
                + "VALUES($1, $2)";

    var insertFriendRequest = new pgp.ParameterizedQuery(insertString);
    db.none(insertString, [requester, requested])
        .then(function() {
            cb();
        })
        .catch(function(err) {
            console.log("insert friend request err", err);
        });
}

const acceptFriendRequest = function(user, requester, cb) {
    var insertFriendShipString = "INSERT INTO friendships(user_a, user_b) "
                + "VALUES ($1, $2), ($2, $1)";
    var deleteRequestString = "DELETE FROM friendship_requests "
                + "WHERE requested=$1 AND requester=$2";

    var insertFriendship = new pgp.ParameterizedQuery(insertFriendShipString);
    var deleteFriendRequest = new pgp.ParameterizedQuery(deleteRequestString);

    db.task(function(t) {
        return t.batch([
            t.none(deleteFriendRequest, [user, requester]),
            t.none(insertFriendship, [user, requester])
        ]);
    })
        .then(function() {
            cb();
        })
        .catch(function(err) {
            console.log("acceptFriendRequest err", err);
        });
}

module.exports = {
    getUser,
    getGraph,
    getFusion,
    getAllUserPlots,
    addPoint,
    addGraph,
    addFusion,
    addGraphsToFusion,
    addFusionRequests,
    acceptFusionRequest,
    graphsBeginWith,
    addFriendRequest,
    acceptFriendRequest,
}

/*
    HELPER FUNCTIONS
*/

/*
    Helper function:
    Constructor function used in getFusion
*/
const createFusionGraphsQ = function(ctx, values) {

    var graphQString = "SELECT * FROM graphs "
                + "WHERE owner = $1 AND id = $2";
    
    var pointsQString = "SELECT graphs.colour, data_points.value, data_points.date "
                + "FROM graphs INNER JOIN data_points ON "
                + "graphs.id = data_points.graph AND graphs.owner = $1 AND graphs.id = $2";
    
    var findGraph = new pgp.ParameterizedQuery(graphQString);
    var findPoints = new pgp.ParameterizedQuery(pointsQString);
    return ctx.tx(function(t) {
        return t.batch([
            t.one(findGraph, values),
            t.any(findPoints, values)
        ])
        .then(function(result) {
            // Formatting the result so that 1 object gets returned, the graph and its attribute, .points, contains all the data points
            var graph = result[0];
            graph.points = result[1];
            return graph;
        })
        .catch(function(err) {
            console.log("createFusionGraphQ err ", err);
        });
    });
}

/*
    Query strings for later use
*/
var getGraphsInFusion =  "SELECT * FROM graphs "
+ "WHERE id IN "
    + "(SELECT graph_id "
    + "FROM fusions_to_graphs as ftg INNER JOIN graphs as g "
    + "ON ftg.fusion_id = g.id)";

var fusionOwnerString = "SELECT f.id, f.date_created, f.name, fto.owner FROM fusions as f, fusions_to_owners as fto WHERE f.id = fto.fusion_id";

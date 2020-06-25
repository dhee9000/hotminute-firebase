const functions = require('firebase-functions');

const admin = require('firebase-admin');
const { firestore, auth } = require('firebase-admin');
admin.initializeApp();

// // Create and Deploy Your First Cloud Functions
// // https://firebase.google.com/docs/functions/write-firebase-functions
//
// exports.helloWorld = functions.https.onRequest((request, response) => {
//  response.send("Hello from Firebase!");
// });


// Agora Functions
const {RtcTokenBuilder, RtmTokenBuilder, RtcRole, RtmRole} = require('agora-access-token');

const AppID = 'b1350a7f93bc4fe18bdc2e3b3a8952e1';
const AppCertificate = '9b06228fbb2f4248a6c6ad5bd8badd05';
const Role = RtcRole.PUBLISHER;

const EXPIRY_IN_SECONDS = 240

generateRTCToken = function generateRTCToken(uid, channel){
    const currentTimestamp = Math.floor(Date.now() / 1000)
    const expiryTime = currentTimestamp + EXPIRY_IN_SECONDS
    const token = RtcTokenBuilder.buildTokenWithAccount(AppID, AppCertificate, channel, uid, Role, 0);
    console.log(`UID: ${uid}, Channel: ${channel}, Token: ${token}`);
    return token;
}

generateCombinedDocId = function (uid1, uid2) {
    if(uid1.localeCompare(uid2) < 0){
        return `${uid1}_${uid2}`;
    }
    else if(uid1.localeCompare(uid2) > 0){
        return `${uid2}_${uid1}`;
    }
    else{
        throw(new Error("cannot create combined id for same user"));
    }
}

exports.onPairRequest = functions.firestore.document('pairingPool/{id}').onCreate(async (pairRequestSnapshot, context) => {
    
    // Get the request params
    let pairRequest = pairRequestSnapshot.data();
    
    // Search for a matching profile in the pool
    let pairSearchReference = firestore().collection('pairingPool').where('active', '==', true);
    let pairSearchReferenceA = pairSearchReference.where('uid', '<', pairRequest.uid);
    let pairSearchReferenceB = pairSearchReference.where('uid', '>', pairRequest.uid);
    
    // Apply Age Filters
    // ageMinBirthdate = pairRequest.minAge // TODO: Implement this
    // ageMaxBirthdate = pairRequest.maxAge // TODO: Implement this
    // pairSearchReference = pairSearchReference.where('dob', '<', ageMinBirthdate);
    // pairSearchReference = pairSearchReference.where('dob', '>', ageMaxBirthdate);

    // Apply Location Filters
    // TODO: Implement

    let results = [];

    // Apply Gender Filters
    if(pairRequest.genders.male){
        pairSearchReferenceMaleA = pairSearchReferenceA.where('gender', '==', 'male');
        pairSearchReferenceMaleB = pairSearchReferenceB.where('gender', '==', 'male');
        let pairSearchSnapshotMaleA = await pairSearchReferenceMaleA.get();
        let pairSearchSnapshotMaleB = await pairSearchReferenceMaleB.get();
        pairSearchSnapshotMaleA.docs.forEach(doc => results.push({...doc.data(), id: doc.id}));
        pairSearchSnapshotMaleB.docs.forEach(doc => results.push({...doc.data(), id: doc.id}));
    }
    if(pairRequest.genders.female){
        let pairSearchReferenceFemaleA = pairSearchReferenceA.where('gender', '==', 'female');
        let pairSearchReferenceFemaleB = pairSearchReferenceB.where('gender', '==', 'female');
        let pairSearchSnapshotFemaleA = await pairSearchReferenceFemaleA.get();
        let pairSearchSnapshotFemaleB = await pairSearchReferenceFemaleB.get();
        pairSearchSnapshotFemaleA.docs.forEach(doc => results.push({...doc.data(), id: doc.id}));
        pairSearchSnapshotFemaleB.docs.forEach(doc => results.push({...doc.data(), id: doc.id}));
    }
    // TODO: Implement
    // if(pairRequest.genders.other){
    //     pairSearchReferenceOther = pairSearchReference.where('gender', '==', 'other');
    //     let pairSearchSnapshotMale = await pairSearchReferenceOther.get();
    //     pairSearchSnapshotMale.docs.forEach(doc => results.push({...doc.data(), id: doc.id}));
    // }

    if(results.length === 0){
        console.log("No matches found for id: " + pairRequestSnapshot.id);
        return;
    }

    // Get Match Parameters
    let matchedUser = results[0];
    let roomId = generateCombinedDocId(pairRequest.uid, matchedUser.uid);

    let batch = firestore().batch();

    // Send Match to Request User
    batch.update(pairRequestSnapshot.ref, { paired: true, pairedUid: matchedUser.uid, active: false, roomId, roomToken: generateRTCToken(pairRequest.uid, roomId) });

    // Send Match to Matched User
    batch.update(firestore().collection('pairingPool').doc(matchedUser.id), { paired: true, pairedUid: pairRequest.uid, active: false, roomId, roomToken: generateRTCToken(matchedUser.uid, roomId) });


    batch.create(
        firestore().collection('pairings').doc(generateCombinedDocId(pairRequest.uid, matchedUser.uid) + "_" + Date.now()),
        { 
            pairedOn: firestore.FieldValue.serverTimestamp(),
            uids: [pairRequest.uid, matchedUser.uid],
            [pairRequest.uid]: pairRequest,
            [matchedUser.uid]: matchedUser
        }
    );

    await batch.commit();
    return;

});

exports.onSwipe = functions.firestore.document('swipes/{id}').onWrite(async (changeSnapshot, context) => {
    
    // Get the snapshot after the change
    let swipeSnapshot = changeSnapshot.after;

    // Get the swipe params
    let swipeData = swipeSnapshot.data();

    // If it was a left swipe
    if(swipeData.direction === 'left'){
        return;
    }

    // See if the other party swiped
    let usersInvolved = context.params.id.split("_");
    let pairSwipeId = `${usersInvolved[1]}_${usersInvolved[0]}`;
    
    let pairSwipeSnapshot = await firestore().collection('swipes').doc(pairSwipeId).get();

    // If it doesn't exist, then exit
    if(!pairSwipeSnapshot.exists){
        return;
    }

    // If it does, check if it was a right swipe
    let pairSwipeData = pairSwipeSnapshot.data();
    if(pairSwipeData.direction === 'right'){

        // Create a match if it was
        firestore().collection('matches').add({
            uids: [usersInvolved[1], usersInvolved[0]],
            dateMatched: firestore.FieldValue.serverTimestamp(),
        });

    }

});

exports.onMessageSent = functions.firestore.document('chats/{chatId}/messages/{messageId}').onCreate(async (messageSnapshot, context) => {

    let messageData = messageSnapshot.data();

    firestore().collection('chats').doc(context.params.chatId).update({
        lastMessageBy: messageData.sentBy,
        lastMessage: messageData.text,
    });

    // TODO: notify user
    
});

exports.resetDatabase = functions.https.onRequest( async (req, res) => {
    
    console.log("RESETTING APPLICATION!")
    
    let batch = firestore().batch();
    
    let pairingPoolEntries = await firestore().collection('pairingPool').get();
    let pairings = await firestore().collection('pairings').get();
    let swipes = await firestore().collection('swipes').get();
    let matches = await firestore().collection('matches').get();
    let chats = await firestore().collection('chats').get()

    let filters = await firestore().collection('filters').get();
    let profiles = await firestore().collection('profiles').get();
    
    pairingPoolEntries.forEach(doc => batch.delete(doc.ref));
    pairings.forEach(doc => batch.delete(doc.ref));
    swipes.forEach(doc => batch.delete(doc.ref));
    matches.forEach(doc => batch.delete(doc.ref));
    chats.forEach(doc => batch.delete(doc.ref));

    filters.forEach(doc => batch.delete(doc.ref));
    profiles.forEach(doc => {
        auth().revokeRefreshTokens(doc.id);
        batch.delete(doc.ref);
    })

    await batch.commit();
    
    console.log("RESET COMPLETE!");

    res.send("Reset Completed!")
});


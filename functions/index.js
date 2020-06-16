const functions = require('firebase-functions');

const admin = require('firebase-admin');
const { firestore } = require('firebase-admin');
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

exports.onPairRequest = functions.firestore.document('pairingPool/{id}').onCreate(async (pairRequestSnapshot, context) => {
    
    // Get the request params
    let pairRequest = pairRequestSnapshot.data();
    
    // Search for a matching profile in the pool
    let pairSearchReference = firestore().collection('pairingPool').where('active', '==', true);
    
    // Apply Age Filters
    // ageMinBirthdate = pairRequest.minAge
    // ageMaxBirthdate = pairRequest.maxAge
    // pairSearchReference = pairSearchReference.where('dob', '<', ageMinBirthdate);
    // pairSearchReference = pairSearchReference.where('dob', '>', ageMaxBirthdate);

    // Apply Location Filters

    let results = [];

    // Apply Gender Filters
    if(pairRequest.genders.male){
        pairSearchReferenceMale = pairSearchReference.where('gender', '==', 'male');
        let pairSearchSnapshotMale = await pairSearchReferenceMale.get();
        pairSearchSnapshotMale.docs.forEach(doc => results.push({...doc.data(), id: doc.id}));
    }
    if(pairRequest.genders.female){
        pairSearchReferenceFemale = pairSearchReference.where('gender', '==', 'female');
        let pairSearchSnapshotMale = await pairSearchReferenceFemale.get();
        pairSearchSnapshotMale.docs.forEach(doc => results.push({...doc.data(), id: doc.id}));
    }
    if(pairRequest.genders.other){
        pairSearchReferenceOther = pairSearchReference.where('gender', '==', 'other');
        let pairSearchSnapshotMale = await pairSearchReferenceOther.get();
        pairSearchSnapshotMale.docs.forEach(doc => results.push({...doc.data(), id: doc.id}));
    }

    // Get Match Parameters
    let matchedUser = results[0];
    let roomId = `${pairRequest.uid}_${matchedUser.uid}`;

    let batch = firestore().batch();

    // Send Match to Request User
    batch.update(pairRequestSnapshot.ref, { paired: true, pairedUid: matchedUser.uid, active: false, roomId, roomToken: generateRTCToken(pairRequest.uid, roomId) });

    // Send Match to Matched User
    batch.update(firestore().collection('pairingPool').doc(matchedUser.id), { paired: true, pairedUid: pairRequest.uid, active: false, roomId, roomToken: generateRTCToken(matchedUser.uid, roomId) });

    await batch.commit();
    return;

});

exports.onSwipe = functions.firestore.document('swipes/{id}').onCreate(async (swipeSnapshot, context) => {
    
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
            uid1: usersInvolved[1],
            uid2: usersInvolved[0],
            dateMatched: firestore.FieldValue.serverTimestamp(),
        });

    }

});


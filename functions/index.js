const functions = require('firebase-functions');

const admin = require('firebase-admin');
const { firestore, auth, messaging, database } = require('firebase-admin');
admin.initializeApp();

// // Create and Deploy Your First Cloud Functions
// // https://firebase.google.com/docs/functions/write-firebase-functions
//
// exports.helloWorld = functions.https.onRequest((request, response) => {
//  response.send("Hello from Firebase!");
// });


// Agora Functions
const { RtcTokenBuilder, RtmTokenBuilder, RtcRole, RtmRole } = require('agora-access-token');

const AppID = 'b1350a7f93bc4fe18bdc2e3b3a8952e1';
const AppCertificate = '9b06228fbb2f4248a6c6ad5bd8badd05';
const Role = RtcRole.PUBLISHER;

const EXPIRY_IN_SECONDS = 240

generateRTCToken = function generateRTCToken(uid, channel) {
    const currentTimestamp = Math.floor(Date.now() / 1000)
    const expiryTime = currentTimestamp + EXPIRY_IN_SECONDS
    const token = RtcTokenBuilder.buildTokenWithAccount(AppID, AppCertificate, channel, uid, Role, 0);
    console.log(`UID: ${uid}, Channel: ${channel}, Token: ${token}`);
    return token;
}

const generateCombinedDocId = (uid1, uid2) => {
    let strings = [uid1, uid2];
    strings.sort();
    return strings[0] + "_" + strings[1]
}

exports.onPairRequest = functions.firestore.document('pairingPool/{id}').onCreate(async (pairRequestSnapshot, context) => {

    // Get the request params
    const pairRequest = pairRequestSnapshot.data();

    MUTEX_REF = database().ref('/MUTEX/PAIR_LOCK');
    await MUTEX_REF.transaction(MUTEX_LOCK => {
        if(MUTEX_LOCK){
            while(MUTEX_LOCK > 0){
                let x = 1;
            }
        }
        MUTEX_LOCK--;
    })

    // Search active pool entries only
    let pairSearchReference = firestore().collection('pairingPool').where('active', '==', true);



    /**
     * APPLY FILTERS
     */

    let results = [];

    // Apply Age Filters
    let minimumDate = new Date(Date.now() - (pairRequest.minAge-1) * 365 * 24 * 60 * 60 * 1000);
    let maximumDate = new Date(Date.now() - (pairRequest.maxAge+1) * 365 * 24 * 60 * 60 * 1000);

    console.log("Date Range: " + minimumDate.toString() + " " + maximumDate.toString());
    pairSearchReference = pairSearchReference.where('dob', '<=', minimumDate).where('dob', '>=', maximumDate);

    // Apply Location Filters
    // TODO: Implement

    // Apply Gender Filters
    if (pairRequest.genders.male) {
        const pairSearchReferenceMale = pairSearchReference.where('gender', '==', 'male');
        const pairSearchSnapshotMale = await pairSearchReferenceMale.get();
        pairSearchSnapshotMale.docs.forEach(doc => results.push({ ...doc.data(), id: doc.id }));
    }
    if (pairRequest.genders.female) {
        const pairSearchReferenceFemale = pairSearchReference.where('gender', '==', 'female');
        const pairSearchSnapshotFemale = await pairSearchReferenceFemale.get();
        pairSearchSnapshotFemale.docs.forEach(doc => results.push({ ...doc.data(), id: doc.id }));
    }
    if (pairRequest.genders.other) {
        const pairSearchReferenceOther = pairSearchReference.where('gender', '==', 'other');
        const pairSearchSnapshotOther = await pairSearchReferenceOther.get();
        pairSearchSnapshotOther.docs.forEach(doc => results.push({ ...doc.data(), id: doc.id }));
    }

    //Remove self
    results = results.filter(record => record.uid !== pairRequest.uid);
    // Filter records where we are not in target gender
    results = results.filter(record => record.genders[pairRequest.gender]);

    if (results.length === 0) {
        console.log("No Profiles Meet Filter Criteria for Pair ID: " + pairRequestSnapshot.id + "with UID " + pairRequest.uid);
        return;
    }


    /**
     * CHECK FOR LEFT SWIPES
     */

    const leftSwipesReference = firestore().collection('swipes').where('uid', '==', pairRequest.uid).where('direction', '==', 'left').where('swipedOn', 'in', results.map(record => record.uid));
    const leftSwipesSnapshot = await leftSwipesReference.get();
    const swipedLeftUids = leftSwipesSnapshot.docs.length > 0 ? leftSwipesSnapshot.docs.map(doc => doc.swipedOn) : [];

    results = results.filter(record => !swipedLeftUids.includes(record.uid));

    if (results.length === 0) {
        console.log("No Profiles Remaining After Eliminating Left Swipes for Pair ID: " + pairRequestSnapshot.id);
        return;
    }

    /**
     * CHECK FOR PREVIOUS MATCHES
     */

    const previousMatchRef = firestore().collection('matches').where('uids', 'array-contains', pairRequest.uid);
    const previousMatchSnapshot = await previousMatchRef.get();
    const previousMatchedUids = previousMatchSnapshot.docs.length > 0 ? previousMatchSnapshot.docs.map(doc => doc.uids.filter(uid => uid !== pairRequest.uid)[0]) : [];

    results = results.filter(record => !previousMatchedUids.includes(record.uid));

    if (results.length === 0) {
        console.log("No Profiles Remaining after Eliminating Previous Matches for Pair ID: " + pairRequestSnapshot.id);
        return;
    }


    // Get Match Parameters
    const matchedUser = results[0];
    const roomId = generateCombinedDocId(pairRequest.uid, matchedUser.uid);

    let batch = firestore().batch();

    // Send Match to Request User
    batch.update(pairRequestSnapshot.ref, { pairedAt: firestore.FieldValue.serverTimestamp(), matchedPairingEntryId: matchedUser.id, paired: true, pairedUid: matchedUser.uid, active: false, roomId, roomToken: generateRTCToken(pairRequest.uid, roomId) });

    // Send Match to Matched User
    batch.update(firestore().collection('pairingPool').doc(matchedUser.id), { pairedAt: firestore.FieldValue.serverTimestamp(), matchedPairingEntryId: pairRequestSnapshot.id, paired: true, pairedUid: pairRequest.uid, active: false, roomId, roomToken: generateRTCToken(matchedUser.uid, roomId) });


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

    await MUTEX_REF.set(1);

    return;

});

exports.onExtend = functions.firestore.document('pairingPool/{id}').onWrite(async (changeSnapshot, context) => {

    // Get the snapshot after change
    let pairingEntrySnapshot = changeSnapshot.after;
    let pairingEntry = pairingEntrySnapshot.data();

    if (!pairingEntry.extended) {
        return;
    }

    firestore().collection('pairingPool').doc(pairingEntry.matchedPairingEntryId).update({
        partnerExtended: true
    });

    console.log("extend reflected successfully")

});

exports.onSwipe = functions.firestore.document('swipes/{id}').onWrite(async (changeSnapshot, context) => {

    // Get the snapshot after the change
    let swipeSnapshot = changeSnapshot.after;

    // Get the swipe params
    let swipeData = swipeSnapshot.data();

    let pairingEntrySnapshot = await firestore().collection('pairingPool').doc(swipeData.pairingId).get();
    let pairingEntryData = pairingEntrySnapshot.data();

    // If it was a left swipe
    if (swipeData.direction === 'left') {
        return;
    }

    // See if the other party swiped
    let usersInvolved = [swipeData.uid, swipeData.swipedOn];
    let meUID = swipeData.uid;
    let themUID = swipeData.swipedOn;

    let pairSwipeSnapshot = await firestore().collection('swipes')
        .where('uid', '==', themUID)
        .where('swipedOn', '==', meUID)
        .where('swipedAt', '>', pairingEntryData.pairedAt)
        .get();

    // If it doesn't exist, then exit
    if (pairSwipeSnapshot.docs.length < 1) {
        return;
    }

    // If it does, check if it was a right swipe
    let pairSwipeData = pairSwipeSnapshot.docs[0].data();
    if (pairSwipeData.direction === 'right') {

        // Create a match if it was
        firestore().collection('matches').doc(generateCombinedDocId(usersInvolved[0], usersInvolved[1])).set({
            uids: [usersInvolved[1], usersInvolved[0]],
            dateMatched: firestore.FieldValue.serverTimestamp(),
        });

        // Then set the call to matched

        let pairingDocQuerySnapshot = await firestore().collection('pairingPool')
            .where('paired', '==', true)
            .where('uid', '==', usersInvolved[0])
            .where('pairedUid', '==', usersInvolved[1])
            .get();
        if (pairingDocQuerySnapshot.docs.length > 0) {
            pairingDocQuerySnapshot.docs.map(doc => {
                doc.ref.update({ matched: true });
            });
        }
        else {
            throw new Error("Couldn't find pairing pool doc!");
        }

        pairingDocQuerySnapshot = await firestore().collection('pairingPool')
            .where('paired', '==', true)
            .where('uid', '==', usersInvolved[1])
            .where('pairedUid', '==', usersInvolved[0])
            .get();
        if (pairingDocQuerySnapshot.docs.length > 0) {
            pairingDocQuerySnapshot.docs.map(doc => {
                doc.ref.update({ matched: true });
            });
        }
        else {
            throw new Error("Couldn't find pairing pool doc!");
        }

    }

    return;

});

exports.onMessageSent = functions.firestore.document('chats/{chatId}/messages/{messageId}').onCreate(async (messageSnapshot, context) => {

    let messageData = messageSnapshot.data();

    await firestore().collection('chats').doc(context.params.chatId).update({
        lastMessageBy: messageData.sentBy,
        lastMessage: messageData.text,
    });

    let senderProfileSnapshot = await firestore().collection('profiles').doc(messageData.sentBy).get();
    let { fname:senderFname } = senderProfileSnapshot.data();
    let otherUid = (await firestore().collection('chats').doc(context.params.chatId).get()).data().uids.filter(uid => uid !== messageData.sentBy)[0];

    let fcmTokenSnapshot = await firestore().collection('users').doc(otherUid).get();
    if (fcmTokenSnapshot.exists) {
        fcmTokenSnapshot.data().fcmTokens.map(async token => {
            messaging().sendToDevice(token, { notification: { title: `Chat from ${senderFname}`, body: messageData.text } });
        });
    }

    return;

});

exports.onUnmatched = functions.firestore.document('matches/{matchId}').onUpdate(async (changeSnapshot, context) => {

    let prevMatchSnapshot = changeSnapshot.before;
    let matchSnapshot = changeSnapshot.after;
    let matchData = matchSnapshot.data();

    // Check if the match was deleted
    if (!prevMatchSnapshot.data().deleted && matchSnapshot.data().deleted) {
        // if the match was deleted
        firestore().collection('matches').doc(context.params.matchId).update({
            deletedBy: context.auth.uid,
        });

        // delete the chats
        firestore().collection('chats').doc(generateCombinedDocId(matchData.uids[0], matchData.uids[1])).delete();
    }

    return;

});

exports.onProfileDeleted = functions.firestore.document('profiles/{profileId}').onDelete(async (docSnapshot, context) => {
    await firestore().collection('deletedProfiles').doc(context.params.profileId).set({ deletedAt: firestore.Timestamp.now() });
});

// exports.resetDatabase = functions.https.onRequest(async (req, res) => {

//     console.log("RESETTING APPLICATION!")

//     let batch = firestore().batch();

//     let pairingPoolEntries = await firestore().collection('pairingPool').get();
//     let pairings = await firestore().collection('pairings').get();
//     let swipes = await firestore().collection('swipes').get();
//     let matches = await firestore().collection('matches').get();
//     let chats = await firestore().collection('chats').get()

//     let filters = await firestore().collection('filters').get();
//     let profiles = await firestore().collection('profiles').get();

//     pairingPoolEntries.forEach(doc => batch.delete(doc.ref));
//     pairings.forEach(doc => batch.delete(doc.ref));
//     swipes.forEach(doc => batch.delete(doc.ref));
//     matches.forEach(doc => batch.delete(doc.ref));
//     chats.forEach(doc => batch.delete(doc.ref));

//     filters.forEach(doc => batch.delete(doc.ref));
//     profiles.forEach(doc => {
//         auth().revokeRefreshTokens(doc.id);
//         batch.delete(doc.ref);
//     })

//     await batch.commit();

//     console.log("RESET COMPLETE!");

//     res.send("Reset Completed!")
// });


import * as functions from "firebase-functions"
import * as admin from "firebase-admin"
const serviceAccount = require('../service-account-file.json')

// import * as speechApi from "@google-cloud/speech/build/src/v1p1beta1"
// import * as axios from 'axios'
// import * as accessToken from 'agora-access-token'
// import * as aws from 'aws-sdk'

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://shmooze-5069b-default-rtdb.firebaseio.com/",
    storageBucket: "shmooze-5069b.appspot.com/"
})

export const stopAudioRecording = functions.https.onCall(async (data: any, context) => {
    const axios = require('axios')
    const appId: string = process.env.appId!
    const customerId: string = process.env.customerId!
    const secret: string = process.env.secret!
    const Authorization: string = `Basic ${Buffer.from(customerId + ':' + secret).toString('base64')}`
    const individualSid: string = data['individualSid']
    const individualResourceId: string = data['individualResourceId']
    const groupSid: string = data['groupSid']
    const groupResourceId: string = data['groupResourceId']
    const shmoozeId: string = data['shmoozeId']
    const receiverUid: string = data['receiverUid']
    const senderUid: string = data['senderUid']
    const inviteId: string = data['inviteId']
    const channelName: string = shmoozeId
    const inviteSnapshot: admin.firestore.DocumentSnapshot | void = await admin.firestore().collection('mailRoom').doc(inviteId).get().catch((error) => console.log(error))
    if (inviteSnapshot === undefined || !inviteSnapshot.exists) {
        return null
    }
    if (shmoozeId !== inviteSnapshot.id || receiverUid !== inviteSnapshot.get('receiver.uid') || senderUid !== inviteSnapshot.get('sender.uid')) {
        return null
    }
    if (context.auth === undefined || context.auth.uid !== inviteSnapshot.get('sender.uid')) {
        return null
    }
    let mode = 'mix'
    let uid = '180'
    await axios.default.post(
        `https://api.agora.io/v1/apps/${appId}/cloud_recording/resourceid/${groupResourceId}/sid/${groupSid}/mode/${mode}/stop`,
        {
            cname: channelName,
            uid: uid,
            clientRequest: {},
        },
        { headers: { Authorization } }
    ).catch((error: any) => {
        console.log(error)
    })
    mode = 'individual'
    uid = '179'
    await axios.default.post(
        `https://api.agora.io/v1/apps/${appId}/cloud_recording/resourceid/${individualResourceId}/sid/${individualSid}/mode/${mode}/stop`,
        {
            cname: channelName,
            uid: uid,
            clientRequest: {},
        },
        { headers: { Authorization } }
    ).catch((error: any) => {
        console.log(error)
    })
    const bucket: string = 'shmooze-5069b'
    const aws = require('aws-sdk')
    aws.config.update({
        accessKeyId: process.env.awsAccessKey,
        secretAccessKey: process.env.awsSecretKey,
        region: 'us-west-1'
    })
    const s3 = new aws.S3()
    const { Contents }: void | any = await s3.listObjects({
        Bucket: bucket,
        Prefix: `shmoozes/${shmoozeId}`
    }).promise().catch((error: any) => console.log(error))
    const batch = admin.firestore().batch()
    if (Contents === undefined) {
        return null
    }
    let numberOfSoloRecordings: number = 0
    let startedRecording: number = Infinity
    let audioRecordingUrl: string = ''
    let audioRecordingKey: string = ''
    for (const content of Contents) {
        const key: string | undefined = content.Key
        if (key === undefined) {
            return null
        }
        const fileName = (key.split('/').pop())!
        let pieces: string[] = fileName.split('_')
        const isSoloRecording = pieces.length > 5
        if (isSoloRecording) {
            if (fileName.endsWith('.ts')) {
                numberOfSoloRecordings = numberOfSoloRecordings + 1
                batch.create(
                    inviteSnapshot.ref.collection('waitingFor').doc(),
                    {}
                )
            }
        }
        else {
            if (fileName.endsWith('.ts')) {
                const lastPart: string = pieces.pop()!
                pieces = lastPart.split('.')
                const year: string = pieces[0].slice(0, 4)
                const month: string = pieces[0].slice(4, 6)
                const day: string = pieces[0].slice(6, 8)
                const hour: string = pieces[0].slice(8, 10)
                const minutes: string = pieces[0].slice(10, 12)
                const seconds: string = pieces[0].slice(12, 14)
                const milliseconds: string = pieces[0].slice(14, 17)
                const startedSpeaking = Date.parse(`${year}-${month}-${day} ${hour}:${minutes}:${seconds}.${milliseconds}`)
                if (startedSpeaking < startedRecording) {
                    startedRecording = startedSpeaking
                }
            }
            else if (fileName.endsWith('.m3u8')) {
                audioRecordingKey = key
                audioRecordingUrl = `https://${bucket}.s3-us-west-1.amazonaws.com/${audioRecordingKey}`
            }
        }
    }
    await batch.commit().catch((error) => console.log(error))
    let hasReceivedFiles: boolean = false
    const receivedQuery: admin.firestore.QuerySnapshot | void = await inviteSnapshot.ref.collection('received').get().catch((error) => console.log(error))
    if (receivedQuery !== undefined && receivedQuery.docs !== undefined && !receivedQuery.empty) {
        if (receivedQuery.docs.length === numberOfSoloRecordings) {
            hasReceivedFiles = true
        }
    }
    if (startedRecording === Infinity || audioRecordingUrl === '') {
        return null
    }
    if (hasReceivedFiles) {
        await inviteSnapshot.ref.update({ hasReceivedFiles: true }).catch((error) => console.log(error))
    }
    let params: any = {
        Bucket: bucket,
        Key: audioRecordingKey,
    }
    const { Body }: void | any = await s3.getObject(params).promise().catch((error: any) => console.log(error))
    if (Body === undefined) {
        return null
    }
    params = {
        Bucket: bucket,
        Key: audioRecordingKey,
        Body: Body,
        ContentType: 'application/x-mpegURL',
        ACL: 'public-read'
    }
    await s3.putObject(params).promise().catch((error: any) => console.log(error))
    await inviteSnapshot.ref.update({ startedRecording: startedRecording, audioRecordingUrl: audioRecordingUrl }).catch((error) => console.log(error))
    const m3u8ToMp4 = require("m3u8-to-mp4")
    const converter = new m3u8ToMp4()
    const path = require('path')
    const os = require('os')
    const tempLocalFile = path.join(os.tmpdir(), 'output.mp4')
    const tempLocalDir = path.dirname(tempLocalFile)
    const mkdirp = require('mkdirp')
    await mkdirp(tempLocalDir).catch((error: any) => console.log(error))
    await converter.setInputFile(audioRecordingUrl).setOutputFile(tempLocalFile).start().catch((error: any) => console.log(error))
    await admin.storage().bucket().upload(tempLocalFile, { destination: `shmoozes/${shmoozeId}/shmooze.mp4` }).catch((error) => console.log(error))
    const results = await admin.storage().bucket().file(`shmoozes/${shmoozeId}/shmooze.mp4`).getSignedUrl({ 'action': 'read', 'expires': '03-17-2150' }).catch((error) => console.log(error))
    audioRecordingUrl = ''
    if (results !== undefined) {
        audioRecordingUrl = results[0]
    }
    const isReadable = (typeof audioRecordingUrl === 'string') && (audioRecordingUrl.length > 0)
    if (!isReadable) {
        return null
    }
    await inviteSnapshot.ref.update({ audioRecordingUrl: audioRecordingUrl }).catch((error) => console.log(error))
    await admin.firestore().collection('shmoozes').doc(inviteSnapshot.id).update({ audioRecordingUrl: audioRecordingUrl }).catch((error) => console.log(error))
    return null
})

export const startAudioRecording = functions.https.onCall(async (data: any, context) => {
    const axios = require('axios')
    const shmoozeId: string = data['shmoozeId']
    const receiverUid: string = data['receiverUid']
    const senderUid: string = data['senderUid']
    const inviteId: string = data['inviteId']
    const channelName: string = shmoozeId
    let uid: string = '179'
    const appId: string = process.env.appId!
    const customerId: string = process.env.customerId!
    const secret: string = process.env.secret!
    const awsSecretKey: string = process.env.awsSecretKey!
    const awsAccessKey: string = process.env.awsAccessKey!
    const appCertificate: string = process.env.appCertificate!
    const bucketName: string = 'shmooze-5069b'
    const inviteSnapshot: admin.firestore.DocumentSnapshot | void = await admin.firestore().collection('mailRoom').doc(inviteId).get().catch((error) => console.log(error))
    if (inviteSnapshot === undefined || !inviteSnapshot.exists) {
        return null
    }
    if (shmoozeId !== inviteSnapshot.id || receiverUid !== inviteSnapshot.get('receiver.uid') || senderUid !== inviteSnapshot.get('sender.uid')) {
        return null
    }
    if (context.auth === undefined || context.auth.uid !== inviteSnapshot.get('sender.uid')) {
        return null
    }
    const shmoozeSnap: admin.firestore.DocumentSnapshot | void = await admin.firestore().collection('shmoozes').doc(shmoozeId).get().catch((error) => console.log(error))
    if (shmoozeSnap === undefined || shmoozeSnap.exists) {
        return null
    }
    const Authorization: string = `Basic ${Buffer.from(customerId + ':' + secret).toString('base64')}`
    let acquire = await axios.default.post(
        `https://api.agora.io/v1/apps/${appId}/cloud_recording/acquire`,
        {
            cname: channelName,
            uid: uid,
            clientRequest: {
                resourceExpiredHour: 24,
            },
        },
        { headers: { Authorization } }
    ).catch((error: any) => console.log(error))
    if (acquire === null || acquire === undefined || acquire.data === null || acquire.data === undefined) {
        return null
    }
    const { RtcTokenBuilder, RtcRole } = require('agora-access-token')
    const role = RtcRole.PUBLISHER
    const expirationTimeInSeconds = 3600 + 180
    let currentTime = Math.floor(Date.now() / 1000)
    let privilegeExpiredTs = currentTime + expirationTimeInSeconds
    let token: string = RtcTokenBuilder.buildTokenWithUid(appId, appCertificate, channelName, parseInt(uid), role, privilegeExpiredTs)
    let resourceId: string = acquire.data.resourceId
    let mode: string = 'individual'
    let start = await axios.default.post(
        `https://api.agora.io/v1/apps/${appId}/cloud_recording/resourceid/${resourceId}/mode/${mode}/start`,
        {
            cname: channelName,
            uid: uid,
            clientRequest: {
                token: token,
                recordingConfig: {
                    streamTypes: 0,
                    maxIdleTime: 300,
                    channelType: 1,
                    subscribeAudioUids: ['177', '178'],
                    subscribeUidGroup: 0,
                },
                recordingFileConfig: {
                    avFileType: ['hls'],
                },
                storageConfig: {
                    vendor: 1,
                    region: 2,
                    bucket: bucketName,
                    accessKey: awsAccessKey,
                    secretKey: awsSecretKey,
                    fileNamePrefix: ['shmoozes', shmoozeId],
                },
            },
        },
        { headers: { Authorization } }
    ).catch((error: any) => console.log(error))
    if (start === null || start === undefined || start.data === null || start.data === undefined) {
        return null
    }
    const individualRecordingData = [start.data.sid, start.data.resourceId]
    uid = '180'
    acquire = await axios.default.post(
        `https://api.agora.io/v1/apps/${appId}/cloud_recording/acquire`,
        {
            cname: channelName,
            uid: uid,
            clientRequest: {
                resourceExpiredHour: 24,
            },
        },
        { headers: { Authorization } }
    ).catch((error: any) => console.log(error))
    if (acquire === null || acquire === undefined || acquire.data === null || acquire.data === undefined) {
        return null
    }
    currentTime = Math.floor(Date.now() / 1000)
    privilegeExpiredTs = currentTime + expirationTimeInSeconds
    token = RtcTokenBuilder.buildTokenWithUid(appId, appCertificate, channelName, parseInt(uid), role, privilegeExpiredTs)
    resourceId = acquire.data.resourceId
    mode = 'mix'
    start = await axios.default.post(
        `https://api.agora.io/v1/apps/${appId}/cloud_recording/resourceid/${resourceId}/mode/${mode}/start`,
        {
            cname: channelName,
            uid: uid,
            clientRequest: {
                token: token,
                recordingConfig: {
                    streamTypes: 0,
                    maxIdleTime: 300,
                    audioProfile: 1,
                    channelType: 1,
                    subscribeAudioUids: ['177', '178'],
                    subscribeUidGroup: 0,
                },
                recordingFileConfig: {
                    avFileType: ['hls'],
                },
                storageConfig: {
                    vendor: 1,
                    region: 2,
                    bucket: bucketName,
                    accessKey: awsAccessKey,
                    secretKey: awsSecretKey,
                    fileNamePrefix: ['shmoozes', shmoozeId],
                },
            },
        },
        { headers: { Authorization } }
    ).catch((error: any) => console.log(error))
    if (start === null || start === undefined || start.data === null || start.data === undefined) {
        return null
    }
    const groupRecordingData = [start.data.sid, start.data.resourceId]
    return individualRecordingData.concat(groupRecordingData)
})

export const retrieveShmooze = functions.https.onCall(async (data: any) => {
    const shmoozeId: string = data['shmoozeId']
    const shmoozeSnapshot: admin.firestore.DocumentSnapshot | void = await admin.firestore().collection('shmoozes').doc(shmoozeId).get().catch((error) => console.log(error))
    if (shmoozeSnapshot === undefined || !shmoozeSnapshot.exists) {
        return null
    }
    const transcriptQuery: admin.firestore.QuerySnapshot | void = await admin.firestore().collection('shmoozes').doc(shmoozeSnapshot.id).collection('transcript').orderBy('mouth.opens', 'asc').get().catch((error) => console.log(error))
    if (transcriptQuery === undefined || transcriptQuery.docs === undefined || transcriptQuery.empty) {
        return null
    }
    const script: any = []
    const senderUid: string = shmoozeSnapshot.get('sender.uid')
    const senderDisplayName: string = shmoozeSnapshot.get('sender.displayName')
    const senderPhotoUrl: string = shmoozeSnapshot.get('sender.photoUrl')
    const receiverDisplayName: string = shmoozeSnapshot.get('receiver.displayName')
    const receiverPhotoUrl: string = shmoozeSnapshot.get('receiver.photoUrl')
    const receiverUid: string = shmoozeSnapshot.get('receiver.uid')
    for (const snapshot of transcriptQuery.docs) {
        if (snapshot === undefined || !snapshot.exists) {
            continue
        }
        const authorUid: string = snapshot.get('authorUid')
        const isSender: boolean = senderUid === authorUid
        let photoUrl
        let displayName
        if (isSender) {
            photoUrl = senderPhotoUrl
            displayName = senderDisplayName
        }
        else {
            photoUrl = receiverPhotoUrl
            displayName = receiverDisplayName
        }
        script.push({ mouth: { opens: snapshot.get('mouth.opens'), closes: snapshot.get('mouth.closes') }, quote: snapshot.get('quote'), displayName: displayName, photoUrl: photoUrl, verseId: snapshot.id })
    }
    let playFrom: number = ((transcriptQuery.docs[0].get('mouth.opens')) - shmoozeSnapshot.get('startedRecording')) - Math.floor(1000 / 3)
    if (playFrom < 0) {
        playFrom = 0
    }
    const playUntil: number = ((transcriptQuery.docs[transcriptQuery.docs.length - 1].get('mouth.closes')) - shmoozeSnapshot.get('startedRecording')) + Math.floor(1000 / 3)
    const shmooze = {
        personA: { displayName: senderDisplayName, photoUrl: senderPhotoUrl, uid: senderUid },
        personB: { displayName: receiverDisplayName, photoUrl: receiverPhotoUrl, uid: receiverUid },
        play: {
            from: playFrom,
            until: playUntil
        },
        shmoozeId: shmoozeSnapshot.id, startedRecording: shmoozeSnapshot.get('startedRecording'), audioRecordingUrl: shmoozeSnapshot.get('audioRecordingUrl'), timeCreated: shmoozeSnapshot.get('timeCreated'), name: '', caption: shmoozeSnapshot.get('caption')
    }
    return [shmooze, script]
})

export const getShmoozes = functions.https.onCall(async (data: any) => {
    const afterTime: number = data['afterTime']
    const shmoozeQuery: admin.firestore.QuerySnapshot | void = await admin.firestore().collection('shmoozes').where('timeCreated', '<', afterTime).orderBy('timeCreated', 'desc').limit(3).get().catch((error) => console.log(error))
    const shmoozes: any[] = []
    const scripts: any[] = []
    if (shmoozeQuery !== undefined && shmoozeQuery.docs !== undefined) {
        for (const shmoozeSnapshot of shmoozeQuery.docs) {
            if (shmoozeSnapshot === undefined || !shmoozeSnapshot.exists) {
                continue
            }
            const transcriptQuery: admin.firestore.QuerySnapshot | void = await admin.firestore().collection('shmoozes').doc(shmoozeSnapshot.id).collection('transcript').orderBy('mouth.opens', 'asc').get().catch((error) => console.log(error))
            const senderUid: string = shmoozeSnapshot.get('sender.uid')
            const senderDisplayName: string = shmoozeSnapshot.get('sender.displayName')
            const senderPhotoUrl: string = shmoozeSnapshot.get('sender.photoUrl')
            const receiverDisplayName: string = shmoozeSnapshot.get('receiver.displayName')
            const receiverPhotoUrl: string = shmoozeSnapshot.get('receiver.photoUrl')
            const receiverUid: string = shmoozeSnapshot.get('receiver.uid')
            if (transcriptQuery !== undefined && transcriptQuery.docs !== undefined) {
                const currentScript: any[] = []
                for (const quoteSnapshot of transcriptQuery.docs) {
                    if (quoteSnapshot === undefined || !quoteSnapshot.exists) {
                        continue
                    }
                    const authorUid: string = quoteSnapshot.get('authorUid')
                    const isSender: boolean = senderUid === authorUid
                    let photoUrl
                    let displayName
                    if (isSender) {
                        photoUrl = senderPhotoUrl
                        displayName = senderDisplayName
                    }
                    else {
                        photoUrl = receiverPhotoUrl
                        displayName = receiverDisplayName
                    }
                    currentScript.push({ mouth: { opens: quoteSnapshot.get('mouth.opens'), closes: quoteSnapshot.get('mouth.closes') }, quote: quoteSnapshot.get('quote'), displayName: displayName, photoUrl: photoUrl, verseId: quoteSnapshot.id, authorUid: authorUid })
                }
                if (currentScript.length === 0) {
                    continue
                }
                let playFrom: number = ((transcriptQuery.docs[0].get('mouth.opens')) - shmoozeSnapshot.get('startedRecording')) - Math.floor(1000 / 3)
                if (playFrom < 0) {
                    playFrom = 0
                }
                const playUntil: number = ((transcriptQuery.docs[transcriptQuery.docs.length - 1].get('mouth.closes')) - shmoozeSnapshot.get('startedRecording')) + Math.floor(1000 / 3)
                shmoozes.push({
                    personA: { displayName: senderDisplayName, photoUrl: senderPhotoUrl, uid: senderUid },
                    personB: { displayName: receiverDisplayName, photoUrl: receiverPhotoUrl, uid: receiverUid },
                    play: {
                        from: playFrom,
                        until: playUntil
                    },
                    shmoozeId: shmoozeSnapshot.id, startedRecording: shmoozeSnapshot.get('startedRecording'), audioRecordingUrl: shmoozeSnapshot.get('audioRecordingUrl'), timeCreated: shmoozeSnapshot.get('timeCreated'), name: shmoozeSnapshot.get('name'), caption: shmoozeSnapshot.get('caption')
                })
                scripts.push(currentScript)
            }
        }
    }
    return [shmoozes, scripts]
})

export const createProfile = functions.https.onCall(async (data: any, context) => {
    const uid: string = data['uid']
    const displayName: string = data['displayName'].trim()
    const photoUrl: string = data['photoUrl']
    if (context.auth !== undefined && context.auth.uid === uid && displayName.length >= 3) {
        const promises: any = []
        promises.push(admin.auth().updateUser(uid, { displayName: displayName, photoURL: photoUrl }).catch((error) => console.log(error)))
        promises.push(admin.firestore().collection('users').doc(uid).create({ displayName: displayName, photoUrl: photoUrl }).catch((error) => console.log(error)))
        return Promise.all(promises)
    }
    return null
})

export const inviteUserForShmooze = functions.https.onCall(async (data: any, context) => {
    const senderUid: string = data['senderUid']
    const receiverUid: string = data['receiverUid']
    const expirationInMillis: number = (60 * 3) * 1000
    if (context.auth === undefined || senderUid === receiverUid || context.auth.uid !== senderUid) {
        return false
    }
    const senderSnapshot: admin.firestore.DocumentSnapshot | void = await admin.firestore().collection('users').doc(senderUid).get().catch((error) => console.log(error))
    if (senderSnapshot === undefined || !senderSnapshot.exists) {
        return false
    }
    const receiverSnapshot: admin.firestore.DocumentSnapshot | void = await admin.firestore().collection('users').doc(receiverUid).get().catch((error) => console.log(error))
    if (receiverSnapshot === undefined || !receiverSnapshot.exists) {
        return false
    }
    const inviteQuery: admin.firestore.QuerySnapshot | void = await admin.firestore().collection('mailRoom').where('receiver.uid', '==', receiverUid).where('expiresIn', '>', Date.now()).orderBy('expiresIn', 'desc').get().catch((error) => console.log(error))
    if (inviteQuery !== undefined && inviteQuery.docs !== undefined) {
        for (const inviteSnapshot of inviteQuery.docs) {
            if (inviteSnapshot.exists && inviteSnapshot.get('status') === 0) {
                return false
            }
        }
    }
    let thereIsAnError: boolean = false
    const inviteId: string = admin.firestore().collection('mailRoom').doc().id
    const expiresIn = Date.now() + expirationInMillis
    await admin.firestore().collection('mailRoom').doc(inviteId).create({ sender: { uid: senderUid, photoUrl: senderSnapshot.get('photoUrl'), displayName: senderSnapshot.get('displayName'), readyToShmoozeIn: null, isAware: false }, status: 0, receiver: { uid: receiverUid, photoUrl: receiverSnapshot.get('photoUrl'), displayName: receiverSnapshot.get('displayName'), readyToShmoozeIn: null, isAware: false }, expiresIn: expiresIn, shmoozeId: inviteId, audioRecordingUrl: null, startedRecording: null, hasTranscript: false, hasReceivedFiles: false }).catch((_) => thereIsAnError = true)
    if (thereIsAnError) {
        return false
    }
    return [inviteId, inviteId]
})

export const letsShmoozeIn = functions.https.onCall(async (data: any, context) => {
    const receiverUid: string = data['receiverUid']
    const senderUid: string = data['senderUid']
    const inviteId: string = data['inviteId']
    const shmoozeId: string = data['shmoozeId']
    if (context.auth === undefined || !(context.auth.uid === receiverUid || context.auth.uid === senderUid)) {
        return null
    }
    const isSender: boolean = context.auth.uid === senderUid
    const isReceiver: boolean = !isSender
    const inviteSnapshot: admin.firestore.DocumentSnapshot | void = await admin.firestore().collection('mailRoom').doc(inviteId).get().catch((error) => console.log(error))
    if (inviteSnapshot === undefined || !inviteSnapshot.exists || inviteSnapshot.get('sender.uid') !== senderUid || inviteSnapshot.get('receiver.uid') !== receiverUid || shmoozeId !== inviteSnapshot.id) {
        return null
    }
    let readyToShmoozeIn: number
    if (isReceiver) {
        readyToShmoozeIn = Date.now() + 5000
    }
    else {
        const receiverIsReadyToShmoozeIn = inviteSnapshot.get('receiver.readyToShmoozeIn')
        const senderIsReadyToShmoozeIn = inviteSnapshot.get('sender.readyToShmoozeIn')
        if (receiverIsReadyToShmoozeIn === null || receiverIsReadyToShmoozeIn <= Date.now() || senderIsReadyToShmoozeIn !== null) {
            return null
        }
        readyToShmoozeIn = receiverIsReadyToShmoozeIn
    }
    let thereIsAnError: boolean = false
    if (isReceiver) {
        await inviteSnapshot.ref.update({ 'sender.readyToShmoozeIn': null, 'receiver.readyToShmoozeIn': readyToShmoozeIn, 'sender.isAware': false, 'receiver.isAware': false }).catch((_) => thereIsAnError = true)
    }
    else {
        await inviteSnapshot.ref.update({ 'sender.readyToShmoozeIn': readyToShmoozeIn, 'sender.isAware': true }).catch((_) => thereIsAnError = true)
    }
    if (thereIsAnError) {
        return -1
    }
    return readyToShmoozeIn
})

export const receiverBecomesAware = functions.https.onCall(async (data: any, context) => {
    const senderUid: string = data['senderUid']
    const inviteId: string = data['inviteId']
    const receiverUid: string = data['receiverUid']
    const shmoozeId: string = data['shmoozeId']
    if (context.auth === undefined || context.auth.uid !== receiverUid) {
        return null
    }
    const inviteSnapshot: admin.firestore.DocumentSnapshot | void = await admin.firestore().collection('mailRoom').doc(inviteId).get().catch((error) => console.log(error))
    if (inviteSnapshot === undefined || !inviteSnapshot.exists) {
        return null
    }
    const senderIsReadyToShmoozeIn: number = inviteSnapshot.get('sender.readyToShmoozeIn')
    const receiverIsReadyToShmoozeIn: number = inviteSnapshot.get('receiver.readyToShmoozeIn')
    const senderIsAware: boolean = inviteSnapshot.get('sender.isAware')
    const receiverIsAware: boolean = inviteSnapshot.get('receiver.isAware')
    if (receiverIsAware === true || shmoozeId !== inviteSnapshot.id || inviteSnapshot.get('sender.uid') !== senderUid || inviteSnapshot.get('receiver.uid') !== receiverUid || senderIsReadyToShmoozeIn !== receiverIsReadyToShmoozeIn || senderIsReadyToShmoozeIn <= Date.now() || !senderIsAware) {
        return null
    }
    return inviteSnapshot.ref.update({ 'receiver.isAware': true }).catch((error) => { console.log(error) })
})

export const updateInviteStatus = functions.https.onCall(async (data: any, context) => {
    const receiverUid: string = data['receiverUid']
    const senderUid: string = data['senderUid']
    const inviteId: string = data['inviteId']
    const status: number = data['status']
    const shmoozeId: string = data['shmoozeId']
    if (context.auth === undefined || !(context.auth.uid === receiverUid || context.auth.uid === senderUid)) {
        return null
    }
    const inviteSnapshot: admin.firestore.DocumentSnapshot | void = await admin.firestore().collection('mailRoom').doc(inviteId).get().catch((error) => console.log(error))
    if (inviteSnapshot === undefined || !inviteSnapshot.exists || inviteSnapshot.id !== shmoozeId || inviteSnapshot.get('sender.uid') !== senderUid || inviteSnapshot.get('receiver.uid') !== receiverUid) {
        return null
    }
    return inviteSnapshot.ref.update({ status: status }).catch((error) => console.log(error))
})

export const getToken = functions.https.onCall(async (data: any, context) => {
    if (context.auth === undefined || context.auth.uid === undefined) {
        return null
    }
    const { RtcTokenBuilder, RtcRole } = require('agora-access-token')
    const appId: string = process.env.appId!
    const appCertificate: string = process.env.appCertificate!
    const shmoozeId: string = data['shmoozeId']
    const inviteId: string = data['inviteId']
    const senderUid: string = data['senderUid']
    const receiverUid: string = data['receiverUid']
    const inviteSnapshot: admin.firestore.DocumentSnapshot | void = await admin.firestore().collection('mailRoom').doc(inviteId).get().catch((error) => console.log(error))
    if (inviteSnapshot === undefined || !inviteSnapshot.exists || inviteSnapshot.id !== shmoozeId || inviteSnapshot.get('sender.uid') !== senderUid || inviteSnapshot.get('receiver.uid') !== receiverUid) {
        return null
    }
    let uid: number
    if (context.auth.uid === inviteSnapshot.get('sender.uid')) {
        uid = 177
    } else if (context.auth.uid === inviteSnapshot.get('receiver.uid')) {
        uid = 178
    }
    else {
        return null
    }
    const role = RtcRole.PUBLISHER
    const expirationTimeInSeconds = 3600
    const currentTime = Math.floor(Date.now() / 1000)
    const privilegeExpiredTs = currentTime + expirationTimeInSeconds
    return RtcTokenBuilder.buildTokenWithUid(appId, appCertificate, shmoozeId, uid, role, privilegeExpiredTs)
})

export const uploadShmooze = functions.https.onCall(async (data: any, context) => {
    if (context.auth === undefined || context.auth.uid === undefined) {
        return null
    }
    const shmoozeId: string = data['shmoozeId']
    const caption: string = data['caption']
    const senderUid: string = data['senderUid']
    const receiverUid: string = data['receiverUid']
    const transcriptQuery: admin.firestore.QuerySnapshot | void = await admin.firestore().collection('shmoozes').doc(shmoozeId).collection('transcript').get().catch((error) => console.log(error))
    if (transcriptQuery === undefined || transcriptQuery.empty) {
        return null
    }
    const inviteSnapshot: admin.firestore.DocumentSnapshot | void = await admin.firestore().collection('mailRoom').doc(shmoozeId).get().catch((error) => console.log(error))
    if (inviteSnapshot === undefined || !inviteSnapshot.exists) {
        return null
    }
    if (inviteSnapshot.get('sender.uid') !== senderUid) {
        return null
    }
    if (inviteSnapshot.get('receiver.uid') !== receiverUid) {
        return null
    }
    if (context.auth.uid !== senderUid) {
        return null
    }
    const senderSnapshot: admin.firestore.DocumentSnapshot | void = await admin.firestore().collection('users').doc(senderUid).get().catch((error) => console.log(error))
    if (senderSnapshot === undefined || !senderSnapshot.exists) {
        return null
    }
    const receiverSnapshot: admin.firestore.DocumentSnapshot | void = await admin.firestore().collection('users').doc(receiverUid).get().catch((error) => console.log(error))
    if (receiverSnapshot === undefined || !receiverSnapshot.exists) {
        return null
    }
    return admin.firestore().collection('shmoozes').doc(shmoozeId).create({ timeCreated: Date.now(), caption: caption.trim(), name: '', sender: { uid: senderUid, photoUrl: senderSnapshot.get('photoUrl'), displayName: senderSnapshot.get('displayName') }, receiver: { uid: receiverUid, photoUrl: receiverSnapshot.get('photoUrl'), displayName: receiverSnapshot.get('displayName') }, audioRecordingUrl: inviteSnapshot.get('audioRecordingUrl'), startedRecording: inviteSnapshot.get('startedRecording') }).catch((error) => console.log(error))
})

export const onShmoozeCreated = functions.firestore.document(`shmoozes/{shmooze}`).onCreate(async (snapshot: admin.firestore.DocumentSnapshot, context) => {
    if (snapshot === undefined || !snapshot.exists) {
        return null
    }
    const inviteSnapshot: admin.firestore.DocumentSnapshot | void = await admin.firestore().collection('mailRoom').doc(context.params.shmooze).get().catch((error) => console.log(error))
    if (inviteSnapshot === undefined || !inviteSnapshot.exists) {
        return null
    }
    const promises: any = []
    promises.push(snapshot.ref.update({
        audioRecordingUrl: inviteSnapshot.get('audioRecordingUrl')
    }).catch((error) => console.log(error)))
    promises.push(admin.firestore().collection('metaData').doc('shmoozes').set({ numberOfShmoozes: admin.firestore.FieldValue.increment(1) }, { merge: true }).catch((error) => console.log(error)))
    return Promise.all(promises)
})

export const onShmoozeDeleted = functions.firestore.document(`shmoozes/{shmooze}`).onDelete(async (snapshot: admin.firestore.DocumentSnapshot, context) => {
    if (snapshot === undefined || !snapshot.exists) {
        return null
    }
    return admin.firestore().collection('metaData').doc('shmoozes').update({ numberOfShmoozes: admin.firestore.FieldValue.increment(-1) }).catch((error) => console.log(error))
})

export const onProfilePhotoReceived = functions.storage.object().onFinalize(async (object) => {
    if (object.name === undefined || object.bucket === undefined) {
        return null
    }
    const pieces: string[] = object.name.split('/')
    if (pieces.length !== 3 || pieces[0] !== 'users' || pieces[2] !== 'photoUrl') {
        return null
    }
    const bucket = admin.storage().bucket()
    const file = bucket.file(object.name)
    let photoUrl: string | undefined
    const results = await file.getSignedUrl({ 'action': 'read', 'expires': '03-17-2150' }).catch((error) => console.log(error))
    if (results !== undefined) {
        photoUrl = results[0]
    }
    const isReadable = (typeof photoUrl === 'string') && (photoUrl.length > 0)
    if (!isReadable) {
        return null
    }
    const uid: string = pieces[1]
    return admin.firestore().collection('users').doc(uid).update({ photoUrl: photoUrl }).catch((error) => console.log(error))
})

export const onAudioReceived = functions.storage.object().onFinalize(async (object) => {
    if (object.name === undefined || object.bucket === undefined) {
        return null
    }
    let pieces: string[] = object.name.split('/')
    if (pieces.length !== 5) {
        return null
    }
    if (pieces[0] !== 'shmoozes' || pieces[2] !== 'users' || !(pieces[4].endsWith('.ts'))) {
        return null
    }
    const shmoozeId = pieces[1]
    const speakerId: string = pieces[3]
    const inviteId = shmoozeId
    const inviteSnapshot: admin.firestore.DocumentSnapshot | void = await admin.firestore().collection('mailRoom').doc(inviteId).get().catch((error) => console.log(error))
    if (inviteSnapshot === undefined || !inviteSnapshot.exists) {
        return null
    }
    const fileName: string = pieces.pop()!
    pieces = fileName.split('_')
    const lastPart: string = pieces.pop()!
    pieces = lastPart.split('.')
    const year: string = pieces[0].slice(0, 4)
    const month: string = pieces[0].slice(4, 6)
    const day: string = pieces[0].slice(6, 8)
    const hour: string = pieces[0].slice(8, 10)
    const minutes: string = pieces[0].slice(10, 12)
    const seconds: string = pieces[0].slice(12, 14)
    const milliseconds: string = pieces[0].slice(14, 17)
    const startedSpeaking = Date.parse(`${year}-${month}-${day} ${hour}:${minutes}:${seconds}.${milliseconds}`)
    if (startedSpeaking > Date.now()) {
        return null
    }
    let prevOpening: number = -1
    const speechApi = require("@google-cloud/speech/build/src/v1p1beta1")
    const client = new speechApi.SpeechClient()
    const gcsUri = `gs://${object.bucket}/${object.name}`
    const recognize: any = await client.longRunningRecognize({
        audio: {
            uri: gcsUri
        },
        config: {
            encoding: 'MP3',
            enableWordTimeOffsets: true,
            diarizationConfig: {
                enableSpeakerDiarization: false,
                minSpeakerCount: 1,
                maxSpeakerCount: 1,
            },
            metadata: {
                interactionType: 'PHONE_CALL',
                microphoneDistance: 'NEARFIELD',
                recordingDeviceType: 'SMARTPHONE',
                originalMediaType: 'AUDIO',
            },
            sampleRateHertz: 48000,
            maxAlternatives: 1,
            audioChannelCount: 1,
            enableAutomaticPunctuation: true,
            languageCode: 'en-US',
            useEnhanced: true,
            model: 'phone_call',
        },
    }).catch((error: any) => console.log(error))
    if (recognize === null || recognize === undefined) {
        return null
    }
    const [operation] = recognize
    const [response] = await operation.promise()
    if (response === null || response === undefined || response.results === null || response.results === undefined) {
        return null
    }
    const isSender: boolean = speakerId === '177'
    let uid: string
    if (isSender) {
        uid = inviteSnapshot.get('sender.uid')
    }
    else {
        uid = inviteSnapshot.get('receiver.uid')
    }
    const promises: any = []
    if (response.results.length !== 0) {
        const result = response.results.pop()
        if (result.alternatives === null || result.alternatives === undefined || result.alternatives.length === 0) {
            return null
        }
        const alternative = result.alternatives[0]
        const words = alternative.words
        if (words === null || words === undefined) {
            return null
        }
        for (const wordInfo of words) {
            if (wordInfo.word === null || wordInfo.word === undefined || wordInfo.startTime === null || wordInfo.startTime === undefined || wordInfo.endTime === null || wordInfo.endTime === undefined) {
                continue
            }
            let startTime: string = `${wordInfo.startTime.seconds}`
            if (wordInfo.startTime.nanos !== undefined && wordInfo.startTime.nanos !== null) {
                startTime = startTime +
                    '.' +
                    wordInfo.startTime.nanos / 100000000
            }
            let endTime: string =
                `${wordInfo.endTime.seconds}`
            if (wordInfo.endTime.nanos !== undefined && wordInfo.endTime.nanos !== null) {
                endTime = endTime + '.' + wordInfo.endTime.nanos / 100000000
            }
            let mouthOpens = startedSpeaking + (parseFloat(startTime) * 1000)
            const mouthCloses = startedSpeaking + (parseFloat(endTime) * 1000)
            if (mouthOpens === prevOpening) {
                mouthOpens = mouthOpens + 1
            }
            promises.push(inviteSnapshot.ref.collection('words').doc().create({
                mouth: { opens: mouthOpens, closes: mouthCloses },
                authorUid: uid,
                word: wordInfo.word,
                audioFile: fileName
            }).catch((error) => console.log(error)))
            prevOpening = mouthOpens
        }
    }
    await Promise.all(promises).catch((error) => console.log(error))
    return inviteSnapshot.ref.collection('received').doc().create({}).catch((error) => console.log(error))
})

export const onFileReceived = functions.firestore.document(`mailRoom/{inviteId}/received/{audioFile}`).onCreate(async (snapshot: admin.firestore.DocumentSnapshot, context) => {
    const waitingForQuery: admin.firestore.QuerySnapshot | void = await admin.firestore().collection('mailRoom').doc(context.params.inviteId).collection('waitingFor').get().catch((error) => console.log(error))
    if (waitingForQuery === undefined || waitingForQuery.docs === undefined || waitingForQuery.empty) {
        return null
    }
    const receivedQuery: admin.firestore.QuerySnapshot | void = await admin.firestore().collection('mailRoom').doc(context.params.inviteId).collection('received').get().catch((error) => console.log(error))
    if (receivedQuery === undefined || receivedQuery.docs === undefined || receivedQuery.empty) {
        return null
    }
    if (receivedQuery.docs.length === waitingForQuery.docs.length) {
        return admin.firestore().collection('mailRoom').doc(context.params.inviteId).update({
            hasReceivedFiles: true
        }).catch((error) => console.log(error))
    }
    return null
})

export const onFinishedRecording = functions.firestore.document(`mailRoom/{inviteId}`).onUpdate(async (change: functions.Change<admin.firestore.QueryDocumentSnapshot>, context: functions.EventContext) => {
    if (!change.before.exists || !change.after.exists) {
        return null
    }
    if (change.before.get('hasReceivedFiles') === undefined) {
        return null
    }
    if (change.after.get('hasReceivedFiles') === undefined) {
        return null
    }
    if (change.before.get('hasReceivedFiles') === change.after.get('hasReceivedFiles')) {
        return null
    }
    if (change.after.get('hasReceivedFiles')) {
        const wordsQuery: admin.firestore.QuerySnapshot | void = await change.after.ref.collection('words').orderBy('mouth.opens', 'asc').get().catch((error) => console.log(error))
        if (wordsQuery === undefined || wordsQuery.docs === undefined || wordsQuery.docs.length === 0) {
            return null
        }
        const promises: any[] = []
        const senderUid = change.after.get('sender.uid')
        const receiverUid = change.after.get('receiver.uid')
        const shmoozeId = context.params.inviteId
        let receiverQuote: string = ''
        let senderQuote: string = ''
        let receiverOpensMouth: number = -1
        let senderOpensMouth: number = -1
        let receiverClosesMouth: number = -1
        let senderClosesMouth: number = -1
        for (let i = 0; i < wordsQuery.docs.length; i++) {
            const wordSnapshot = wordsQuery.docs[i]
            if (!wordSnapshot.exists) {
                continue
            }
            const uid = wordSnapshot.get('authorUid')
            const isSender: boolean = uid === senderUid
            if (isSender) {
                const receiverIsSpeaking: boolean = receiverQuote.length > 0
                if (receiverIsSpeaking) {
                    continue
                }
                if (senderQuote.length === 0) {
                    senderOpensMouth = wordSnapshot.get('mouth.opens')
                    senderQuote = wordSnapshot.get('word')
                    senderQuote = senderQuote[0].toUpperCase() + senderQuote.slice(1, senderQuote.length)
                }
                else {
                    senderQuote = senderQuote + ' ' + wordSnapshot.get('word').toLowerCase()
                }
                senderClosesMouth = wordSnapshot.get('mouth.closes')
            }
            else {
                const senderIsSpeaking: boolean = senderQuote.length > 0
                if (senderIsSpeaking) {
                    continue
                }
                if (receiverQuote.length === 0) {
                    receiverOpensMouth = wordSnapshot.get('mouth.opens')
                    receiverQuote = wordSnapshot.get('word')
                    receiverQuote = receiverQuote[0].toUpperCase() + receiverQuote.slice(1, receiverQuote.length)
                }
                else {
                    receiverQuote = receiverQuote + ' ' + wordSnapshot.get('word').toLowerCase()
                }
                receiverClosesMouth = wordSnapshot.get('mouth.closes')
            }
            if (isSender) {
                const hasFinished: boolean = senderQuote.endsWith('?') || senderQuote.endsWith('!') || senderQuote.endsWith('.')
                const endsWithAnd: boolean = (i < wordsQuery.docs.length - 1) && (wordsQuery.docs[i + 1].exists) && (wordsQuery.docs[i + 1].get('word') === 'and') && (wordsQuery.docs[i + 1].get('authorUid') === senderUid)
                const endsWithComma: boolean = senderQuote.endsWith(',')
                const hasSaidAtLeast5Words = senderQuote.split(' ').length >= 5
                if (hasFinished || ((endsWithAnd || endsWithComma) && hasSaidAtLeast5Words)) {
                    const _senderOpensMouth: number = senderOpensMouth
                    const _senderClosesMouth: number = senderClosesMouth
                    if (endsWithComma) {
                        senderQuote = senderQuote.slice(0, senderQuote.length - 1)
                    }
                    const _senderQuote: string = senderQuote
                    promises.push(
                        admin.firestore().collection('shmoozes').doc(shmoozeId).collection('transcript').doc().create(
                            {
                                mouth: { opens: _senderOpensMouth, closes: _senderClosesMouth },
                                quote: _senderQuote,
                                authorUid: senderUid,
                            }
                        ).catch((error) => console.log(error))
                    )
                    senderOpensMouth = senderClosesMouth = -1
                    senderQuote = ''
                }
            }
            else {
                const hasFinished: boolean = receiverQuote.endsWith('?') || receiverQuote.endsWith('!') || receiverQuote.endsWith('.')
                const endsWithAnd: boolean = (i < wordsQuery.docs.length - 1) && (wordsQuery.docs[i + 1].exists) && (wordsQuery.docs[i + 1].get('word') === 'and') && (wordsQuery.docs[i + 1].get('authorUid') === receiverUid)
                const endsWithComma: boolean = receiverQuote.endsWith(',')
                const hasSaidAtLeast5Words = receiverQuote.split(' ').length >= 5
                if (hasFinished || ((endsWithAnd || endsWithComma) && hasSaidAtLeast5Words)) {
                    const _receiverOpensMouth: number = receiverOpensMouth
                    const _receiverClosesMouth: number = receiverClosesMouth
                    if (endsWithComma) {
                        receiverQuote = receiverQuote.slice(0, receiverQuote.length - 1)
                    }
                    const _receiverQuote: string = receiverQuote
                    promises.push(
                        admin.firestore().collection('shmoozes').doc(shmoozeId).collection('transcript').doc().create({
                            mouth: { opens: _receiverOpensMouth, closes: _receiverClosesMouth },
                            quote: _receiverQuote,
                            authorUid: receiverUid,
                        }).catch((error) => console.log(error))
                    )
                    receiverOpensMouth = receiverClosesMouth = -1
                    receiverQuote = ''
                }
            }
        }
        const senderIsSpeaking: boolean = senderQuote.length > 0
        if (senderIsSpeaking) {
            const _senderOpensMouth: number = senderOpensMouth
            const _senderClosesMouth: number = senderClosesMouth
            const _senderQuote: string = senderQuote
            promises.push(
                admin.firestore().collection('shmoozes').doc(shmoozeId).collection('transcript').doc().create(
                    {
                        mouth: { opens: _senderOpensMouth, closes: _senderClosesMouth },
                        quote: _senderQuote,
                        authorUid: senderUid,
                    }
                ).catch((error) => console.log(error))
            )
        }
        const receiverIsSpeaking: boolean = receiverQuote.length > 0
        if (receiverIsSpeaking) {
            const _receiverOpensMouth: number = receiverOpensMouth
            const _receiverClosesMouth: number = receiverClosesMouth
            const _receiverQuote: string = receiverQuote
            promises.push(
                admin.firestore().collection('shmoozes').doc(shmoozeId).collection('transcript').doc().create(
                    {
                        mouth: { opens: _receiverOpensMouth, closes: _receiverClosesMouth },
                        quote: _receiverQuote,
                        authorUid: receiverUid,
                    }
                ).catch((error) => console.log(error))
            )
        }
        await Promise.all(promises).catch((error) => console.log(error))
        return change.after.ref.update({ hasTranscript: true }).catch((error) => console.log(error))
    }
    return null
})

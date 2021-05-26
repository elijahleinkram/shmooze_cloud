const admin = require('firebase-admin')
const serviceAccount = require('service-account-file.json')
const aws = require('aws-sdk')
const s3 = new aws.S3({ apiVersion: '2006-03-01' })
const mkdirp = require('mkdirp')
const os = require('os')
const path = require('path')
const fs = require('fs').promises

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://shmooze-5069b-default-rtdb.firebaseio.com/",
    storageBucket: "shmooze-5069b.appspot.com/"
})

exports.lambdaHandler = async (event, context) => {
    const key = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, ' '))
    if (!key.endsWith('.ts')) {
        return null
    }
    const awsBucket = event.Records[0].s3.bucket.name
    const params = {
        Bucket: awsBucket,
        Key: key,
    }
    const { Body, ContentType } = await s3.getObject(params).promise().catch((error) => console.log(error))
    if (Body === undefined) {
        return null
    }
    const fileName = (key.split('/').pop())
    const pieces = fileName.split('_')
    const isSoloRecording = pieces.length > 5
    if (isSoloRecording) {
        const shmoozeId = pieces[1]
        const speakerId = pieces[5]
        const inviteSnapshot = await admin.firestore().collection('mailRoom').doc(shmoozeId).get().catch((error) => console.log(error))
        if (inviteSnapshot === undefined || !inviteSnapshot.exists) {
            return null
        }
        const tempLocalFile = path.join(os.tmpdir(), fileName)
        const tempLocalDir = path.dirname(tempLocalFile)
        await mkdirp(tempLocalDir).catch((error) => console.log(error))
        await fs.writeFile(tempLocalFile, Body).catch((error) => console.log(error))
        const gcpBucket = admin.storage().bucket()
        await gcpBucket.upload(tempLocalFile, { destination: `shmoozes/${shmoozeId}/users/${speakerId}/${fileName}` }).catch((error) => console.log(error))
        await fs.unlink(tempLocalFile).catch((error) => console.log(error))
    }
    else {
        const contentType = 'video/MP2T'
        if (contentType === ContentType) {
            return null
        }
        const params = {
            Bucket: awsBucket,
            Key: key,
            Body: Body,
            ContentType: contentType,
            ACL: 'public-read'
        }
        await s3.putObject(params).promise().catch((error) => console.log(error))
    }
    return null
}

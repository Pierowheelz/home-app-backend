// const mongoose = require('../../common/services/mongoose.service').mongoose;
// const Schema = mongoose.Schema;
const users = require('../../common/config/env.config.js').users;

// const userSchema = new Schema({
//     firstName: String,
//     lastName: String,
//     email: String,
//     password: String,
//     permissionLevel: Number
// });
//
// userSchema.virtual('id').get(function () {
//     return this._id.toHexString();
// });
//
// // Ensure virtual fields are serialised.
// userSchema.set('toJSON', {
//     virtuals: true
// });
//
// userSchema.findById = function (cb) {
//     return this.model('Users').find({id: this.id}, cb);
// };

// const User = mongoose.model('Users', userSchema);


exports.findByEmail = (email) => {
    //return User.find({email: email});
    
    let userInfo = null;
    users.forEach( (user, i) => {
        if( user.email == email ){
            userInfo = user;
        }
    } );
    return userInfo;
};
exports.findById = (id) => {
    // return User.findById(id)
    //     .then((result) => {
    //         result = result.toJSON();
    //         delete result._id;
    //         delete result.__v;
    //         return result;
    //     });
    let userInfo = null;
    users.forEach( (user, i) => {
        if( user._id == id ){
            userInfo = user;
        }
    } );
    
    return userInfo;
};

exports.createUser = (userData) => {
    //const user = new User(userData);
    //return user.save();
    
    console.log('New user: ', userData);
    return true
};

exports.list = (perPage, page) => {
    // return new Promise((resolve, reject) => {
    //     User.find()
    //         .limit(perPage)
    //         .skip(perPage * page)
    //         .exec(function (err, users) {
    //             if (err) {
    //                 reject(err);
    //             } else {
    //                 resolve(users);
    //             }
    //         })
    // });
    
    let userList = [];
    users.forEach( (user, i) => {
        userList.push({
            _id: user._id,
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            permissionLevel: user.permissionLevel
        });
    });
    
    return userList;
};

// exports.patchUser = (id, userData) => {
//     return User.findOneAndUpdate({
//         _id: id
//     }, userData);
// };
//
// exports.removeById = (userId) => {
//     return new Promise((resolve, reject) => {
//         User.deleteMany({_id: userId}, (err) => {
//             if (err) {
//                 reject(err);
//             } else {
//                 resolve(err);
//             }
//         });
//     });
// };

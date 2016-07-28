import {IRole, Role} from "../cmn/models/Role";
import {IPermission, Permission} from "../cmn/models/Permission";
import {IRoleGroup, RoleGroup} from "../cmn/models/RoleGroup";
import {Vql} from "vesta-schema/Vql";
import {setting} from "../config/setting";
import {populate} from "../config/db-population";
import {IUser} from "../cmn/models/User";

export interface IGroupsList {
    [group:string]:Array<IRole>
}

export interface IRolesList {
    [role:string]:Array<IPermission>
}

interface IResourceList {
    [name:string]:Array<string>;
}

export enum AclPolicy {Allow = 1, Deny}
export enum AclScope{Model = 1, Entity, Field}
/**
 * Private (Read mine, Write mine)
 * Shared (Read all, Write mine)
 * ReadOnly (Read all, Write none)
 * Public (Read aa, Write all)
 */
export enum AclAccessType {Private = 1, Shared, ReadOnly, Public}

export class Acl {
    private resourceList:IResourceList = {
        '*': ['*', 'read', 'create', 'update', 'delete']
    };
    private roles:IRolesList = {};
    private defaultPolicy = AclPolicy.Deny;
    private groups:IGroupsList = {};

    constructor(defaultPolicy:AclPolicy, roles?:Array<IRole>, groups?:Array<IRoleGroup>) {
        this.defaultPolicy = defaultPolicy;
        this.update(roles, groups);
    }

    public allow(roleName:string, resource:string, action?:string) {
        if (!(roleName in this.roles)) {
            this.roles[roleName] = [];
        }
        this.roles[roleName].push(<IPermission>{resource, action: action || '*'});
    }

    public getGroupRoles(groupName) {
        let roles:Array<IRole> = JSON.parse(JSON.stringify(this.groups[groupName]));
        for (let i = roles.length; i--;) {
            let roleName = roles[i]['name'];
            if (this.roles[roleName]) {
                roles[i].permissions = this.roles[roleName];
            }
        }
        return roles;
    }

    public isAllowed(groupName:string, resource:string, action:string):boolean {
        if (!(groupName in this.groups)) return this.defaultPolicy == AclPolicy.Allow;
        for (let j = this.groups[groupName].length; j--;) {
            if (this.groups[groupName][j].status) {
                let roleName = this.groups[groupName][j].name;
                for (let i = this.roles[roleName].length; i--;) {
                    let permission = this.roles[roleName][i];
                    if (permission.resource == '*' || permission.resource == resource) {
                        if (permission.action == '*' || permission.action == action) return true;
                    }
                }
            }
        }
        return false;
    }

    public update(roles:Array<IRole>, groups:Array<IRoleGroup>) {
        if (!roles || !roles.length) return;
        for (let i = roles.length; i--;) {
            let role = roles[i];
            if (role.status) {
                for (let j = role.permissions.length; j--;) {
                    let permission:IPermission = <IPermission>role.permissions[j];
                    if (permission.status) this.allow(role.name, permission.resource, permission.action);
                }
            }
        }
        for (let i = groups.length; i--;) {
            let group = groups[i];
            if (group.status && group.roles) {
                this.groups[group['name']] = this.groups[group['name']] || [];
                this.groups[group['name']] = group.roles;
            }
        }
    }

    public addResource(resource:string, action:string) {
        if (!this.resourceList[resource]) {
            this.resourceList[resource] = ['*'];
        }
        if (this.resourceList[resource].indexOf(action) < 0) {
            this.resourceList[resource].push(action);
        }
    }

    public get resources() {
        return this.resourceList;
    }

    public initAcl() {
        let updateAclPromise:Array<Promise<any>> = [];
        // let permissionsToAdd:Array<IPermission> = [],
        //     permissionsToRemove:Array<IPermission> = [];
        return Permission.findByQuery<Permission>(new Vql(Permission.schema.name))
            .then(result=> {
                let resources = this.resources;
                for (let resource in resources) {
                    if (resources.hasOwnProperty(resource)) {
                        let resourcePermissions = resources[resource];
                        for (let i = 0; i < resourcePermissions.length; i++) {
                            let found = false;
                            let action = resourcePermissions[i];
                            for (let j = result.items.length; j--;) {
                                if (result.items[j].resource == resource && result.items[j].action == action) {
                                    found = true;
                                    break;
                                }
                            }
                            if (!found) {
                                // permissionsToAdd.push({resource, action});
                                updateAclPromise.push(new Permission({
                                    resource: resource,
                                    action: action
                                }).insert());
                            }
                        }
                    }
                }
                for (let i = result.items.length; i--;) {
                    let aclResource:string = result.items[i].resource;
                    let aclAction:string = result.items[i].action;
                    if (!resources[aclResource] || resources[aclResource].indexOf(aclAction) < 0) {
                        updateAclPromise.push(new Permission({id: result.items[i].id}).delete())
                        // permissionsToRemove.push({id: result.items[i].id});
                    }
                }
                return Promise.all(updateAclPromise).then(()=> {
                    if (setting.regenerateSchema) return populate()
                });
            })
            .then(()=> {
                let rolePromise = new Promise((resolve, reject)=> {
                    let query = new Vql(Role.schema.name);
                    query.fetchRecordFor('permissions');
                    Role.findByQuery<IRole>(query).then(result=> {
                        if (result.error) return reject(result.error);
                        resolve(result.items)
                    });
                });
                let groupPromise = new Promise((resolve, reject)=> {
                    let query = new Vql(RoleGroup.schema.name);
                    query.fetchRecordFor('roles');
                    RoleGroup.findByQuery<IRoleGroup>(query).then(result=> {
                        if (result.error) return reject(result.error);
                        resolve(result.items)
                    });
                });

                return Promise.all([rolePromise, groupPromise]).then(data=> {
                    this.update(<Array<IRole>>data[0], <Array<IRoleGroup>>data[1]);
                })

            })
    }

    /**
     * check if the user has access to execute the query or not
     *
     */
    public hasAccess(query:Vql, user:IUser):boolean {
        if (user.username == 'root') return true;
        return false;
    }
}
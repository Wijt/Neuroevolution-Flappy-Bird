class Bird {
    constructor(x, y, brain) {
        this.pos = {x: x, y: y};
        this.radius = BIRD_R,

        this.live = true;
        this.point = 0;
        this.velocity = 0;

        this.brain = brain || new NeuralNetwork([4,8,8,1]);
        this.brain.mutate();
        this.fitness = 0;
        
        birds.push(this);
    }

    show(){
        push();
            noStroke();
            fill(color(BIRD_COLOR));
            ellipse(this.pos.x, this.pos.y, this.radius, this.radius);
        pop();
    }

    think(){
        let inputs = [];
        inputs[0] = nextPipe.pos.x;
        inputs[1] = this.pos.y;
        inputs[2] = this.velocity;
        inputs[3] = nextPipe.pos.y;
        inputs[4] = nextPipe.topPipe.y2;
        let result = this.brain.feedForward(inputs);
        //console.log(result, inputs);
        if(result[0] > 0){
            this.jump();
        }
        //console.log(result);
    }

    jump(){
        this.velocity = 0;
        this.velocity -= BIRD_JUMP_POWER;
    }

    die(){
        //console.warn("HIT!");
        this.live = false;
        birds.splice(birds.indexOf(this), 1);
        deadBirds.push(this);
    }

    update() {
        if(this.live){
            this.think();
            if (this.pos.y < 0 || this.pos.y > height - GROUND_HEIGHT){
                this.fitness-=3000;
                this.die();
            }
        }

        if(this.pos.y < height - GROUND_HEIGHT){
            this.pos.y += this.velocity;
            this.velocity += GRAVITY;
        }else{
            this.pos.y = height - GROUND_HEIGHT;
        }
        this.fitness += frameCount;
    }

}